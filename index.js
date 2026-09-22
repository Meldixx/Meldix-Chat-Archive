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
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = s => String(s ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
  const dt = value => { try { return new Date(value).toISOString(); } catch (_) { return ""; } };
  let activeRun = null;
  let lastFile = "";
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
  function toTxt(message) {
    const body = [];
    if (message.text && message.text.trim()) body.push(message.text.replace(/\r\n?/g, "\n"));
    for (const attachment of message.attachments) body.push("[вложение: " + clean(attachment.name).replace(/\s+/g, " ").trim() + "]");
    for (const sticker of message.stickers) body.push("[стикер: " + clean(sticker.name).replace(/\s+/g, " ").trim() + "]");
    if (!body.length) return "";
    const date = message.timestamp ? message.timestamp.replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "дата неизвестна";
    return "[" + date + "] " + message.author + ": " + body.join("\n");
  }
  async function save(path, data) {
    if(!manager?.writeFile) throw Error("Не найден FileManager; нельзя сохранить TXT.");
    return manager.writeFile("documents", path, data, "utf8");
  }
  async function exportChat(rawId, onProgress) {
    if(activeRun) throw Error("Экспорт уже запущен.");
    const {channelStore,currentUser,http}=resolveDependencies();
    const meta=validateChannel(rawId,channelStore,currentUser);
    const file=exportRoot + "/chat-" + meta.id + "-" + Date.now() + ".txt";
    const messages=[];
    let oldest=null, pages=0, complete=false, error="";
    activeRun={stop:false};
    try {
      while(!activeRun.stop) {
        const page=await fetchPage(http,meta.id,oldest);
        pages++;
        if(!page.length){complete=true;break;}
        const seen=new Set();
        for(const raw of page) {
          if(!raw?.id || seen.has(raw.id))continue;
          seen.add(raw.id);
          const msg=formatMessage(raw,meta.me);
          if(toTxt(msg))messages.push(msg);
        }
        const next=String(page[page.length-1]?.id||"");
        if(!next||next===oldest)throw Error("Пагинация остановилась: Discord вернул повторную страницу.");
        oldest=next;
        onProgress("Загружено " + messages.length + " сообщений · страниц " + pages + ". По завершении будет один TXT.");
        if(page.length<100){complete=true;break;}
        await wait(450);
      }
      if(activeRun.stop)error="Остановлено вручную";
    } catch(e) {
      error=String(e?.message||e);
    } finally {
      try {
        if(messages.length) {
          // Discord gives messages newest-first; the TXT is strictly oldest-first.
          messages.sort((a,b)=>a.timestamp.localeCompare(b.timestamp) || a.id.length-b.id.length || a.id.localeCompare(b.id));
          const txt=messages.map(toTxt).filter(Boolean).join("\n\n") + "\n";
          await save(file,txt);
          lastFile=file;
        }
      } catch(e) {
        error+=(error?"; ":"")+"Ошибка сохранения: "+String(e?.message||e);
        lastFile="";
      }
      activeRun=null;
    }
    if(error && !lastFile)throw Error(error);
    return {complete,count:messages.length,file:lastFile,reason:error};
  }
  async function shareFile(){
    if(!lastFile)throw Error("Сначала собери переписку.");
    const path=manager.getConstants().DocumentsDirPath+"/"+lastFile;
    if(typeof RN.Share?.share==="function"){
      try {
        await RN.Share.share({url:"file://"+path,title:"Meldix Chat Archive"});
        return "Открыто меню отправки TXT.";
      } catch(_) { /* Some Android FileProviders reject private app files. */ }
    }
    const content=await manager.readFile(path,"utf8");
    if(content.length>80000)throw Error("TXT сохранён в Documents, но системная отправка файла недоступна в этой сборке. Для большого чата нужно извлечь файл через файловый менеджер/ADB.");
    if(typeof clipboard?.setString!=="function")throw Error("Недоступен буфер обмена.");
    await clipboard.setString(content);
    return "Текст чата скопирован. Вставь его в файл или заметку.";
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
    const [message,setMessage]=R.useState("Экспорт одного DM в один TXT без JSON и отчётов.");
    const [working,setWorking]=R.useState(false);
    const mounted=R.useRef(true);
    R.useEffect(()=>{mounted.current=true;notifyStatus=m=>{if(mounted.current)setMessage(m)};return()=>{mounted.current=false;notifyStatus=()=>{}}},[]);
    const label=text=>h(RN.Text,{style:styles.label},text);
    const button=(text,fn,outline=false,disabled=false)=>h(RN.Pressable,{onPress:fn,disabled,style:[outline?styles.outline:styles.action,disabled&&{opacity:.35}]},h(RN.Text,{style:outline?styles.outlineText:styles.actionText},text));
    async function runExport(){
      if(working)return;
      setWorking(true);setMessage("Проверяю личный чат…");
      try{
        const result=await exportChat(channel,setMessage);
        setMessage((result.complete?"Готово. ":"Неполный экспорт. ")+result.count+" сообщений.\nTXT: "+result.file+(result.reason?"\nПричина: "+result.reason:""));
      }catch(e){setMessage("Ошибка: "+String(e?.message||e));}
      finally{if(mounted.current)setWorking(false)}
    }
    async function share(){try{setMessage(await shareFile())}catch(e){setMessage(String(e?.message||e))}}
    return h(RN.ScrollView,{style:styles.base,contentContainerStyle:{paddingBottom:55}},
      h(RN.Text,{style:styles.heading},"Meldix Chat Archive"),
      h(RN.Text,{style:styles.subtitle},"Вся доступная переписка выбранного личного чата одним файлом chat-....txt, от старых сообщений к новым."),
      h(RN.View,{style:styles.card},label("ID личного DM-канала"),
        h(RN.TextInput,{style:styles.input,placeholder:"ID канала или ссылка на сообщение",placeholderTextColor:colors.faded,value:channel,onChangeText:setChannel,autoCorrect:false}),
        h(RN.Text,{style:styles.info},"Вставь ссылку на сообщение из личного чата либо ID самого DM-канала, не пользователя."),
        button("Собрать чат в TXT",runExport,false,working || !!activeRun),
        button("Остановить и сохранить полученное",()=>{if(activeRun){activeRun.stop=true;setMessage("Останавливаю и сохраняю один TXT…")}},true,!working)
      ),
      h(RN.View,{style:styles.card},label("Экспорт"),h(RN.Text,{style:styles.line},message)),
      h(RN.View,{style:styles.card},label("Готовый TXT"),
        h(RN.Text,{style:styles.info},lastFile||"Файла пока нет"),
        button("Поделиться одним TXT",share,false,!lastFile)
      ),
      h(RN.View,{style:styles.card},label("Приватность"),
        h(RN.Text,{style:styles.info},"Экспорт доступной истории одного DM: дата, время UTC, автор, текст и названия вложений/стикеров. Нет сторонних серверов, отчётов и JSON. Личные сообщения не публикуй без согласия второй стороны."))
    );
  }
  return {
    onLoad(){V.logger?.log?.("Meldix Chat Archive loaded (no automatic reads)");},
    onUnload(){if(activeRun)activeRun.stop=true;notifyStatus=()=>{};},
    settings:Settings
  };
})()
