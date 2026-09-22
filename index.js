(() => {
  "use strict";
  // Revenge Classic / Bunny / Vendetta plugin format. No network endpoint other
  // than Discord's first-party authenticated client API is ever contacted.
  const V = vendetta;
  const R = V.metro.common.React;
  const RN = V.metro.common.ReactNative;
  const metro = V.metro;
  const manager = globalThis.nativeModuleProxy?.DCDFileManager || globalThis.nativeModuleProxy?.RTNFileManager;
  const clipboard = V.metro.common.clipboard;
  const colors = { bg: "#171422", panel: "#272036", text: "#FAEDF6", soft: "#D7B7CF", faded: "#A99BB2", accent: "#F3C7DF", green: "#B6E3CA", danger: "#F5ABBD" };
  const h = R.createElement;
  const exportRoot = "MeldixChatArchive";
  const chunkSize = 200;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = s => String(s ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
  const safeFile = s => String(s ?? "archive").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 70);
  const dt = value => { try { return new Date(value).toISOString(); } catch (_) { return ""; } };
  let activeRun = null;
  let lastFolder = "", lastFiles = [], lastIndex = 0;
  let notifyStatus = () => {};
  function status(message) { notifyStatus(message); }
  function find(...names) {
    const f = metro.findByProps || metro.filters?.findByProps;
    return typeof f === "function" ? f(...names) : null;
  }
  function resolveDependencies() {
    // Use Discord's existing authenticated request client. Never extract a user token.
    const channelStore = find("getChannel", "getDMFromUserId") || find("getChannel", "getChannels");
    const currentUser = find("getCurrentUser", "getUser");
    const http = find("get", "post", "put", "del") || find("get", "post", "patch", "del");
    if (!http?.get) throw Error("Не найден внутренний HTTP-клиент Discord для этой версии приложения.");
    if (!channelStore?.getChannel || !currentUser?.getCurrentUser) throw Error("Не найдены ChannelStore / UserStore. Возможно, версия Discord несовместима.");
    return { channelStore, currentUser, http };
  }
  function validateChannel(raw, channelStore, currentUser) {
    const entered = String(raw || "").trim();
    const match = entered.match(/(?:discord(?:app)?\.com\/channels\/(?:@me|\d+)\/)(\d{17,22})(?:\/\d+)?/);
    const id = match ? match[1] : entered;
    if (!/^\d{17,22}$/.test(id)) throw Error("Введи ID личного чата или ссылку на DM.");
    const channel = channelStore.getChannel(id);
    if (!channel) throw Error("Канал не найден в Discord. Открой личный чат и попробуй ещё раз.");
    if (Number(channel.type) !== 1) throw Error("Можно экспортировать только личную переписку один на один, не группы и не серверы.");
    const me = currentUser.getCurrentUser();
    if (!me?.id) throw Error("Не удалось получить текущего пользователя.");
    const others = (channel.recipients || []).map(r => typeof r === "string" ? r : r.id).filter(id => id !== me.id);
    if (others.length !== 1) throw Error("Не удалось подтвердить второго участника этого DM. Экспорт остановлен.");
    return { id, me: me.id, other: others[0], channel };
  }
  function formatMessage(m, me) {
    return {
      id: String(m.id || ""),
      timestamp: dt(m.timestamp || Math.floor(Number(m.id) / 4194304) + 1420070400000),
      authorId: String(m.author?.id || ""),
      author: clean(m.author?.global_name || m.author?.globalName || m.author?.username || "Неизвестно"),
      own: String(m.author?.id) === me,
      text: clean(m.content),
      edited: m.edited_timestamp ? dt(m.edited_timestamp) : null,
      replyTo: m.message_reference?.message_id || null,
      attachments: (m.attachments || []).map(a => ({ id: String(a.id), name: clean(a.filename), type: a.content_type || null, size: a.size || 0, width: a.width || null, height: a.height || null })),
      stickers: (m.sticker_items || []).map(s => ({ id: String(s.id), name: clean(s.name) })),
      reactions: (m.reactions || []).map(r => ({ name: r.emoji?.name, count: r.count || 0 })),
      type: m.type ?? 0
    };
  }
  function statusCode(err) { return Number(err?.status || err?.response?.status || err?.body?.status || 0); }
  function responseBody(response) { return response?.body ?? response?.data ?? response; }
  async function fetchPage(http, channelId, before) {
    const path = `/channels/${channelId}/messages?limit=100` + (before ? `&before=${before}` : "");
    for (let tries = 0; tries < 5; tries++) {
      if (activeRun?.stop) throw Error("Остановлено вручную.");
      try {
        const res = await http.get({ url: path });
        const status = Number(res?.status || 200);
        const body = responseBody(res);
        if (status === 429 || body?.retry_after) {
          await wait(Math.min(60000, Math.max(1200, Number(body.retry_after || 2) * 1000)));
          continue;
        }
        if (status >= 400) throw Object.assign(Error(`Discord HTTP ${status}`), { status });
        if (!Array.isArray(body)) throw Error("Discord вернул неожиданный формат сообщений.");
        return body;
      } catch (e) {
        if (statusCode(e) !== 429 || tries === 4) throw e;
        const retry = Number(e?.body?.retry_after || e?.response?.body?.retry_after || 2);
        await wait(Math.min(60000, Math.max(1200, retry * 1000)));
      }
    }
    throw Error("Лимит Discord: повтори позже.");
  }
  function simplify(text) { return clean(text).replace(/\s+/g, " ").trim(); }
  const topics = [
    { label: "Ведьмак 3 / игры", re: /ведьмак|witcher|геральт|гвинт|квест|играем|поиграем|катка|игр[аыу]/i },
    { label: "Discord / войс", re: /дискорд|discord|войс|созвон|голосов|микрофон|зайди|зайду в войс/i },
    { label: "Ночь / сон", re: /ноч[ьи]|спокойной|спать|высп|проснул|утром|поздно|ещё пять минут/i },
    { label: "Мяу / коты", re: /мяу|кот[ауы]|кош[ауы]/i },
    { label: "Забота / настроение", re: /как ты|как дела|всё хорошо|плохо|груст|пережива|отдыхай|не грусти|береги|держись/i },
    { label: "Расстояние / страны", re: /украин|герман|далеко|расстоян|приех|встрет|погуля/i },
    { label: "Юмор / подколы", re: /ахах|хахах|лол|шут|прик[оа]л|иди нахуй|иди на хуй|ржу|ору/i }
  ];
  function createStats() { return { total:0, first:null, last:null, users:{}, words:{}, topics:topics.map(t=>({name:t.label, count:0, examples:[]})), samples:[], daySet:{}, attachmentCount:0, replyCount:0 }; }
  function updateStats(stats, m) {
    stats.total++;
    stats.first = !stats.first || m.timestamp < stats.first ? m.timestamp : stats.first;
    stats.last = !stats.last || m.timestamp > stats.last ? m.timestamp : stats.last;
    const key=m.authorId || "unknown";
    stats.users[key] = stats.users[key] || {name:m.author,count:0,own:m.own};stats.users[key].count++;
    stats.attachmentCount += m.attachments.length;
    if (m.replyTo) stats.replyCount++;
    if(m.timestamp) stats.daySet[m.timestamp.slice(0,10)]=true;
    const text=simplify(m.text);
    if(!text)return;
    for(const [name,re] of topics.map(t=>[t.label,t.re])){
      if(re.test(text)){
        const t=stats.topics.find(s=>s.name===name);t.count++;
        if(t.examples.length<16) t.examples.push({date:m.timestamp,by:m.author,own:m.own,text:text.slice(0,280),id:m.id});
      }
    }
    if(stats.samples.length<25 && text.length>=22 && text.length<300 && !/https?:\/\//i.test(text))stats.samples.push({by:m.author,text,id:m.id});
  }
  function buildReport(stats, meta, complete, parts) {
    const userLines=Object.values(stats.users).map(u=>`- ${u.name} (${u.own?"ты":"собеседница"}): ${u.count}`).join("\n");
    const head=`# Наши сообщения — черновик для сайта\n\nЭкспорт: ${new Date().toISOString()}\nЛичный чат: ${meta.id}\nСобеседница: ${meta.other}\nСтатус: ${complete?"завершён (достигнуто начало доступной истории)":"НЕПОЛНЫЙ — прерван или возникла ошибка"}\nПолучено: ${stats.total} сообщений; сохранено частей: ${parts}; дней переписки: ${Object.keys(stats.daySet).length}.\nСамое раннее доступное: ${stats.first||"неизвестно"}; самое позднее: ${stats.last||"неизвестно"}.\nВложения (метаданные): ${stats.attachmentCount}.\n\n## Авторы\n${userLines}\n\n## Подтверждённые повторяющиеся темы\n`;
    const body=stats.topics.filter(t=>t.count).sort((a,b)=>b.count-a.count).map(t=>`### ${t.name} — ${t.count} сообщений с совпадениями\n${t.examples.slice(0,10).map(x=>`- ${x.date} · ${x.by}: «${x.text.replace(/\n/g," ")}» [id:${x.id}]`).join("\n")}`).join("\n\n");
    const tail="\n\n## Как использовать для сайта\n- Не выдавать фрагменты за дословную цитату, если они сокращены. Сверять по id с полным архивом.\n- Отличать его слова от её слов. Нельзя утверждать её чувства по одному сообщению.\n- Не помещать в публичный сайт адреса, номера, пароли, медицинские детали, интимные сообщения и другие частные сведения.\n- Уточнять контекст шуток: частые совпадения — ещё не показатель важности.\n- Если написано НЕПОЛНЫЙ, не делать выводы обо всей истории.\n";
    return head+(body||"Совпадений по встроенным темам нет. Проверяй полный архив.")+tail;
  }
  async function save(path, data) {
    if(!manager?.writeFile)throw Error("Не найден FileManager; нельзя безопасно сохранить экспорт.");
    return manager.writeFile("documents", path, data, "utf8");
  }
  async function exportChat(rawId, onProgress) {
    if(activeRun)throw Error("Экспорт уже запущен.");
    const {channelStore,currentUser,http}=resolveDependencies();
    const meta=validateChannel(rawId,channelStore,currentUser);
    const folder=`${exportRoot}/${safeFile(meta.id)}-${Date.now()}`;
    let oldest=null,prevOldest=null,page=0,part=0,total=0,complete=false,lastErr="";
    let buffer=[],seen=new Set(),stats=createStats(),files=[];
    activeRun={stop:false};
    async function flush(){
      if(!buffer.length)return;
      part++;const file=`${folder}/messages-${String(part).padStart(4,"0")}.json`;
      const data={format:"MeldixChatArchive-1",channel:meta.id,users:[meta.me,meta.other],part,complete:false,messages:buffer.slice().reverse()};
      await save(file,JSON.stringify(data,null,2));
      files.push(file);buffer=[];
    }
    try {
      while(!activeRun.stop){
        const result=await fetchPage(http,meta.id,oldest);
        page++;if(!result.length){complete=true;break;}
        seen.clear();
        for(const raw of result){
          if(!raw?.id||seen.has(raw.id))continue;seen.add(raw.id);
          const msg=formatMessage(raw,meta.me);buffer.push(msg);updateStats(stats,msg);total++;
          if(buffer.length>=chunkSize)await flush();
        }
        const last=result[result.length-1];
        prevOldest=oldest;oldest=String(last?.id||"");
        if(!oldest||oldest===prevOldest)throw Error("Пагинация остановилась: Discord вернул повторную страницу.");
        onProgress(`Загружено ${total} сообщений · страниц ${page} · частей ${part}${buffer.length?' + '+buffer.length+' в памяти':''}`);
        // Discord history is exhausted when the page contains fewer than 100 entries.
        if(result.length<100){complete=true;break;}
        await wait(450);
      }
      if(activeRun.stop)lastErr="Остановлено вручную";
    }catch(e){lastErr=String(e?.message||e);}
    finally{
      try {
        await flush();
        const index={version:1,dmId:meta.id,otherId:meta.other,selfId:meta.me,complete,reason:lastErr||null,messages:total,parts:files.map(f=>f.split('/').pop()).reverse(),firstDate:stats.first,lastDate:stats.last,generated:new Date().toISOString()};
        files.push(`${folder}/index.json`);await save(files[files.length-1],JSON.stringify(index,null,2));
        files.push(`${folder}/site-notes.md`);await save(files[files.length-1],buildReport(stats,meta,complete,part));
        lastFiles=files;lastFolder=folder;lastIndex=files.length-1;
      }catch(e){lastErr+=(lastErr?"; ":"")+`Сохранение: ${String(e?.message||e)}`;}
      activeRun=null;
    }
    return {complete,count:total,parts:part,folder,files,reason:lastErr};
  }
  async function shareFile(index){
    if(!lastFiles.length)throw Error("Сначала запусти экспорт.");
    const file=lastFiles[index]||lastFiles[lastFiles.length-1];
    const path=`${manager.getConstants().DocumentsDirPath}/${file}`;
    if(typeof RN.Share?.share==="function"){
      try { await RN.Share.share({url:`file://${path}`,title:"Meldix Chat Archive"});return "Запрошено системное меню отправки файла."; }
      catch(_){ /* Android FileProvider may reject private app file:// paths. */ }
    }
    const text=await manager.readFile(path,"utf8");
    if(text.length>80000)throw Error("Файл больше 80 000 символов. Он сохранён в Documents, но системная отправка недоступна. Извлеки через ADB или экспортируй следующую часть через менеджер файлов.");
    if(typeof clipboard?.setString!=="function")throw Error("Недоступен системный буфер обмена.");
    await clipboard.setString(text);
    return "Файл скопирован в буфер обмена. Вставь в локальную заметку; не отправляй в публичный чат.";
  }
  const styles={
    base:{flex:1,backgroundColor:colors.bg,padding:16},
    heading:{fontSize:25,fontWeight:"800",color:colors.text,marginBottom:8},
    subtitle:{fontSize:13,lineHeight:20,color:colors.soft,marginBottom:15},
    label:{fontSize:12,fontWeight:"700",color:colors.accent,marginBottom:8},
    input:{minHeight:45,borderRadius:12,borderWidth:1,borderColor:"#50405F",paddingHorizontal:13,backgroundColor:colors.panel,color:colors.text,marginBottom:10},
    card:{padding:16,backgroundColor:colors.panel,borderWidth:1,borderColor:"#44354D",borderRadius:17,marginBottom:12},
    action:{borderRadius:12,padding:14,marginTop:9,alignItems:"center",backgroundColor:colors.accent},
    outline:{borderRadius:12,padding:14,marginTop:9,alignItems:"center",borderWidth:1,borderColor:colors.accent},
    actionText:{fontWeight:"800",fontSize:13,color:colors.bg},
    outlineText:{fontWeight:"700",fontSize:13,color:colors.text},
    info:{fontSize:12,color:colors.soft,lineHeight:19},
    line:{fontSize:12,color:colors.green,marginTop:10,lineHeight:19},
    error:{fontSize:12,color:colors.danger,marginTop:10,lineHeight:19}
  };
  function Settings(){
    const [channel,setChannel]=R.useState("");
    const [message,setMessage]=R.useState("Выбери ТОЛЬКО конкретный личный чат. Начало: ввод ID канала.");
    const [working,setWorking]=R.useState(false);
    const [fileIndex,setFileIndex]=R.useState(lastIndex);
    const mounted=R.useRef(true);
    R.useEffect(()=>{mounted.current=true;notifyStatus=m=>{if(mounted.current)setMessage(m)};return()=>{mounted.current=false;notifyStatus=()=>{}}},[]);
    const label=(text)=>h(RN.Text,{style:styles.label},text);
    const button=(text,fn,outline=false,disabled=false)=>h(RN.Pressable,{onPress:fn,disabled,style:[outline?styles.outline:styles.action,disabled&&{opacity:.35}]},h(RN.Text,{style:outline?styles.outlineText:styles.actionText},text));
    async function runExport(){
      if(working)return;
      setWorking(true);setMessage("Проверяю личный чат…");
      try{
        const result=await exportChat(channel,setMessage);
        setMessage((result.complete?"Готово. ":"Частичный экспорт. ")+`${result.count} сообщений, ${result.parts} файлов истории.\nПапка: ${result.folder}`+(result.reason?"\nПричина: "+result.reason:""));
        setFileIndex(lastFiles.length-1);
      }catch(e){setMessage("Ошибка: "+String(e?.message||e));}
      finally{if(mounted.current)setWorking(false)}
    }
    async function share(){try{setMessage(await shareFile(fileIndex))}catch(e){setMessage(String(e?.message||e))}}
    return h(RN.ScrollView,{style:styles.base,contentContainerStyle:{paddingBottom:55}},
      h(RN.Text,{style:styles.heading},"Meldix Chat Archive"),
      h(RN.Text,{style:styles.subtitle},"Локальный экспорт ОДНОГО личного чата и подборка фактических цитат для будущего сайта. Плагин не делает выводов о её чувствах."),
      h(RN.View,{style:styles.card},label("ID личного DM-канала"),
        h(RN.TextInput,{style:styles.input,placeholder:"Например, 1234567890123456789",placeholderTextColor:colors.faded,keyboardType:"numeric",value:channel,onChangeText:setChannel,autoCorrect:false}),
        h(RN.Text,{style:styles.info},"Скопируй ссылку на сообщение из нужного DM: discord.com/channels/@me/ID/ID. Можно вставить ссылку целиком либо только ID канала. НЕ ID пользователя. Группы и серверы запрещены."),
        button("Собрать доступную историю",runExport,false,working || !!activeRun),
        button("Остановить после текущего запроса",()=>{if(activeRun){activeRun.stop=true;setMessage("Останавливаю и сохраняю то, что уже собрано…")}},true,!activeRun)
      ),
      h(RN.View,{style:styles.card},label("Ход экспорта"),h(RN.Text,{style:styles.line},message)),
      h(RN.View,{style:styles.card},label("Готовые файлы"),
        h(RN.Text,{style:styles.info},`Папка: ${lastFolder||"ещё нет"}\nФайлов: ${lastFiles.length}. Включает index.json и site-notes.md.`),
        button("Предыдущий файл",()=>setFileIndex(i=>Math.max(0,i-1)),true,!lastFiles.length||fileIndex===0),
        button("Следующий файл",()=>setFileIndex(i=>Math.min(lastFiles.length-1,i+1)),true,!lastFiles.length||fileIndex>=lastFiles.length-1),
        h(RN.Text,{style:styles.line},lastFiles[fileIndex]||"Нет выбранного файла"),
        button("Поделиться / скопировать выбранный файл",share,false,!lastFiles.length),
        button("Выбрать отчёт для сайта",()=>setFileIndex(lastFiles.length-1),true,!lastFiles.length)
      ),
      h(RN.View,{style:styles.card},label("Приватность и точность"),
        h(RN.Text,{style:styles.info},"Только личный чат с подтверждённым вторым участником. Обращения идут лишь к Discord через его внутренний клиент. Токен не извлекается и не записывается. Вебхуки/облачные AI отсутствуют. Вложения сохраняются только как метаданные без загрузки файлов. Экспорт содержит личные сообщения обоих участников: храни безопасно и не публикуй без согласия. Удалённые или недоступные сообщения восстановить нельзя."))
    );
  }
  return {
    onLoad(){V.logger?.log?.("Meldix Chat Archive loaded (no automatic reads)");},
    onUnload(){if(activeRun)activeRun.stop=true;notifyStatus=()=>{};},
    settings:h(Settings)
  };
})()
