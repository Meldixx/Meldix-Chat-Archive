(() => {
  "use strict";
  // Revenge Classic / Bunny / Vendetta plugin format. No network endpoint other
  // than Discord's first-party authenticated client API is ever contacted.
  const V = vendetta;
  const R = V.metro.common.React;
  const RN = V.metro.common.ReactNative;
  const metro = V.metro;
  // Discord exposes its file module under different names and through different
  // React Native registries depending on Android / Revenge version.
  function resolveFileManager() {
    const names = ["NativeFileModule", "RTNFileManager", "DCDFileManager"];
    const registries = [RN?.NativeModules, globalThis.nativeModuleProxy];
    for (const name of names) {
      for (const registry of registries) {
        try {
          const mod = registry?.[name];
          if (typeof mod?.writeFile === "function") return mod;
        } catch (_) {}
      }
      try {
        const mod = typeof globalThis.__turboModuleProxy === "function"
          ? globalThis.__turboModuleProxy(name)
          : null;
        if (typeof mod?.writeFile === "function") return mod;
      } catch (_) {}
    }
    throw Error("В этой сборке Discord не найден модуль сохранения TXT (NativeFileModule / RTNFileManager / DCDFileManager). Экспорт не запускается, чтобы не потерять переписку.");
  }
  const colors = { bg: "#171422", panel: "#272036", text: "#FAEDF6", soft: "#D7B7CF", faded: "#A99BB2", accent: "#F3C7DF", green: "#B6E3CA", danger: "#F5ABBD" };
  const h = R.createElement;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = s => String(s ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
  const dt = value => { try { return new Date(value).toISOString(); } catch (_) { return ""; } };
  let activeRun = null;
  let pendingFile = null, savedFile = null;
  let notifyStatus = () => {};
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
  // Android scoped storage: public Downloads is written through the system's
  // ACTION_CREATE_DOCUMENT picker, not via private app Documents or raw /Download.
  function resolveSavePicker() {
    const module = find("pick", "saveDocuments") || find("saveDocuments");
    const picker = module?.saveDocuments ? module : module?.default?.saveDocuments ? module.default : null;
    if (typeof picker?.saveDocuments !== "function") {
      throw Error("В этой версии Discord отсутствует системное «Сохранить как…». Нужна сборка с @react-native-documents/picker (saveDocuments).");
    }
    return picker;
  }
  async function saveTemp(file, data) {
    const manager=resolveFileManager();
    const result=await manager.writeFile("cache",file,data,"utf8");
    const path=typeof result==="string"&&result.length?result:
      (manager.getConstants?.()?.CacheDirPath || manager.CacheDirPath || "")+"/"+file;
    if(!path || path==="/"+file)throw Error("TXT подготовлен, но Android не сообщил путь временного файла.");
    return {file,manager,path};
  }
  function asFileUri(path) {
    if(path.startsWith("file://"))return path;
    if(!path.startsWith("/"))throw Error("Android вернул неожиданный путь файла: "+path);
    return "file://"+path;
  }
  function cancelledSave(error) {
    return /cancel|cancell|отмен/i.test(String(error?.code||error?.message||error||""));
  }
  async function saveToDownloads(){
    if(!pendingFile)throw Error("Сначала собери переписку.");
    const picker=resolveSavePicker();
    const file=pendingFile;
    let saved;
    try {
      // Android opens a system save dialog. The user picks Downloads and taps Save.
      const result=await picker.saveDocuments({
        sourceUris:[asFileUri(file.path)],
        mimeType:"text/plain",
        fileName:file.file
      });
      saved=result?.[0];
    } catch(error) {
      if(cancelledSave(error))return {cancelled:true};
      throw Error("Не получилось открыть сохранение Android: "+String(error?.message||error));
    }
    if(saved?.error)throw Error("Android не сохранил TXT: "+saved.error);
    if(!saved?.uri)throw Error("Android не подтвердил сохранение TXT. Нажми «Сохранить в Загрузки» ещё раз.");
    savedFile={name:saved.name||file.file,uri:saved.uri};
    pendingFile=null;
    try {await file.manager.removeFile?.("cache",file.file)} catch (_) {}
    return {saved:true,name:savedFile.name,uri:savedFile.uri};
  }
  async function exportChat(rawId, onProgress) {
    if(activeRun) throw Error("Экспорт уже запущен.");
    const {channelStore,currentUser,http}=resolveDependencies();
    const meta=validateChannel(rawId,channelStore,currentUser);
    resolveFileManager(); // Validate both prerequisites before downloading a long chat.
    resolveSavePicker();
    const file="chat-" + meta.id + "-" + Date.now() + ".txt";
    pendingFile=null;
    savedFile=null;
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
          pendingFile=await saveTemp(file,txt);
        }
      } catch(e) {
        error+=(error?"; ":"")+"Ошибка сохранения: "+String(e?.message||e);
        pendingFile=null;
      }
      activeRun=null;
    }
    if(error && !pendingFile)throw Error(error);
    return {complete,count:messages.length,file:pendingFile?.file||"",reason:error};
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
    const [message,setMessage]=R.useState("Один TXT: после загрузки выбери папку «Загрузки» в системном окне Android.");
    const [working,setWorking]=R.useState(false);
    const mounted=R.useRef(true);
    R.useEffect(()=>{mounted.current=true;notifyStatus=m=>{if(mounted.current)setMessage(m)};return()=>{mounted.current=false;notifyStatus=()=>{}}},[]);
    const label=text=>h(RN.Text,{style:styles.label},text);
    const button=(text,fn,outline=false,disabled=false)=>h(RN.Pressable,{onPress:fn,disabled,style:[outline?styles.outline:styles.action,disabled&&{opacity:.35}]},h(RN.Text,{style:outline?styles.outlineText:styles.actionText},text));
    async function openSave(){
      if(!pendingFile)throw Error("Нет подготовленного TXT.");
      setMessage("Выбери «Загрузки» в системном окне Android и нажми «Сохранить».");
      const saved=await saveToDownloads();
      if(saved.cancelled)setMessage("Сохранение отменено. TXT подготовлен — можно нажать «Сохранить в Загрузки» снова, не скачивая чат повторно.");
      else setMessage("TXT сохранён через Android: "+saved.name+"\nМесто: выбранная папка (выбери «Загрузки»).");
    }
    async function runExport(){
      if(working)return;
      setWorking(true);setMessage("Проверяю личный чат…");
      try{
        const result=await exportChat(channel,setMessage);
        if(!pendingFile){
          setMessage("В доступной истории нет сообщений для TXT."+(result.reason?"\nПричина: "+result.reason:""));
          return;
        }
        setMessage((result.complete?"Собрано: ":"Собрано частично: ")+result.count+" сообщений.\nОткроется системное сохранение. Выбери «Загрузки» и подтверди.");
        await openSave();
        if(result.reason) setMessage(prev=>prev+"\nВнимание: переписка неполная. "+result.reason);
      }catch(e){setMessage("Ошибка: "+String(e?.message||e)+(pendingFile?"\nTXT подготовлен; попробуй кнопку сохранения ещё раз.":""));}
      finally{if(mounted.current)setWorking(false)}
    }
    async function retrySave(){
      if(working)return;
      setWorking(true);
      try{await openSave()}catch(e){setMessage("Ошибка сохранения: "+String(e?.message||e));}
      finally{if(mounted.current)setWorking(false)}
    }
    return h(RN.ScrollView,{style:styles.base,contentContainerStyle:{paddingBottom:55}},
      h(RN.Text,{style:styles.heading},"Meldix Chat Archive"),
      h(RN.Text,{style:styles.subtitle},"Экспорт одного DM в один TXT. После загрузки откроется окно Android: выбери «Загрузки» (Downloads)."),
      h(RN.View,{style:styles.card},label("ID личного DM-канала"),
        h(RN.TextInput,{style:styles.input,placeholder:"ID канала или ссылка на сообщение",placeholderTextColor:colors.faded,value:channel,onChangeText:setChannel,autoCorrect:false}),
        h(RN.Text,{style:styles.info},"Вставь ссылку на сообщение из личного чата либо ID самого DM-канала, не пользователя."),
        button("Собрать чат и сохранить в Загрузки",runExport,false,working || !!activeRun),
        button("Остановить и сохранить полученное",()=>{if(activeRun){activeRun.stop=true;setMessage("Останавливаю; затем выбери «Загрузки»…")}},true,!activeRun)
      ),
      h(RN.View,{style:styles.card},label("Экспорт"),h(RN.Text,{style:styles.line},message)),
      h(RN.View,{style:styles.card},label("Один TXT в Загрузках"),
        h(RN.Text,{style:styles.info},savedFile?"Сохранён: "+savedFile.name:pendingFile?"Готов к сохранению: "+pendingFile.file:"Пока не сохранён"),
        button("Сохранить в Загрузки",retrySave,false,working || !pendingFile)
      ),
      h(RN.View,{style:styles.card},label("Приватность"),
        h(RN.Text,{style:styles.info},"Один TXT с датами UTC, авторами и сообщениями. Система попросит выбрать место сохранения; открой «Загрузки» и нажми «Сохранить». Файл будет доступен через обычный файловый менеджер. Это личная переписка — не публикуй без согласия второго участника."))
    );
  }
  return {
    onLoad(){V.logger?.log?.("Meldix Chat Archive loaded (no automatic reads)");},
    onUnload(){if(activeRun)activeRun.stop=true;notifyStatus=()=>{};},
    settings:Settings
  };
})()
