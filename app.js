/* SBBL - Frontend starter.
   Semua izin penting tetap ditegakkan di Supabase RLS/RPC, bukan hanya kode ini. */
const $ = (id) => document.getElementById(id);
const clientReady = Boolean(
  window.SBBL_CONFIG &&
  /^https:\/\//.test(window.SBBL_CONFIG.SUPABASE_URL || "") &&
  (window.SBBL_CONFIG.SUPABASE_ANON_KEY || "").length > 30 &&
  !String(window.SBBL_CONFIG.SUPABASE_URL).includes("PROJECT_REF") &&
  !String(window.SBBL_CONFIG.SUPABASE_ANON_KEY).includes("PASTE_")
);

let supabaseClient = null;
let currentUser = null;
let currentProfile = null;
let transactions = [];
let notifications = [];
let categories = [];
let activeMemberStatus = "approved";
let authQueue = Promise.resolve();
let authRun = 0;
let uiBound = false;
const rupiah = (n) => new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:0}).format(Number(n||0));
const dateID = (s) => new Date(`${s}T00:00:00`).toLocaleDateString("id-ID",{day:"2-digit",month:"short",year:"numeric"});
function toast(message){const el=$("toast");if(!el)return;el.textContent=message;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),3500)}
function showOnly(id){["authScreen","waitingScreen","blockedScreen","appShell"].forEach(x=>{const el=$(x);if(el)el.classList.toggle("hidden",x!==id)})}
function isManager(){return Boolean(currentProfile && ["super_admin","admin"].includes(currentProfile.role))}
function isSuper(){return currentProfile?.role==="super_admin"}
function setText(id,value){const el=$(id);if(el)el.textContent=value}
function monthNow(){return new Date().toISOString().slice(0,7)}
function monthStart(m){return `${m}-01`}
function nextMonth(m){const [y,mo]=m.split("-").map(Number);return new Date(y,mo,1).toISOString().slice(0,10)}
function safe(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}

async function init(){
  setText("year",new Date().getFullYear());
  setText("currentPeriod",new Date().toLocaleDateString("id-ID",{month:"long",year:"numeric"}));
  if($("reportMonth"))$("reportMonth").value=monthNow();
  if($("transactionMonthFilter"))$("transactionMonthFilter").value=monthNow();
  if($("txDate"))$("txDate").value=new Date().toISOString().slice(0,10);
  if(!clientReady || !window.supabase?.createClient){
    showOnly("authScreen");
    const b=$("googleLogin");if(b){b.disabled=true;b.textContent="Konfigurasi Supabase belum siap"}
    toast("Periksa config.js dan koneksi Supabase.");return;
  }
  supabaseClient=window.supabase.createClient(
    window.SBBL_CONFIG.SUPABASE_URL,
    window.SBBL_CONFIG.SUPABASE_ANON_KEY,
    {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:"pkce"}}
  );
  $("googleLogin")?.addEventListener("click",loginGoogle);
  $("waitingLogout")?.addEventListener("click",logout);
  $("blockedLogout")?.addEventListener("click",logout);
  $("logoutButton")?.addEventListener("click",logout);

  // Supabase OAuth callback and restored sessions are processed in one queue
  // to prevent the initial getSession() call racing the SIGNED_IN event.
  supabaseClient.auth.onAuthStateChange((_event,session)=>{
    authQueue=authQueue.then(()=>handleSession(session)).catch(err=>{
      console.error("SBBL auth state error:",err);
      showOnly("blockedScreen");setText("blockedMessage","Sesi login tidak dapat diproses. Muat ulang halaman dan coba kembali.");
    });
  });
  const {data,error}=await supabaseClient.auth.getSession();
  if(error){console.error("SBBL getSession:",error);toast("Gagal membaca sesi login: "+error.message)}
  authQueue=authQueue.then(()=>handleSession(data?.session||null)).catch(err=>console.error(err));
  await authQueue;
  if(!uiBound){bindUI();uiBound=true;}
}

async function loginGoogle(){
  if(!supabaseClient)return toast("Koneksi Supabase belum siap.");
  const button=$("googleLogin");
  if(button){button.disabled=true;button.textContent="Menghubungkan ke Google..."}
  const redirectTo=window.location.origin+window.location.pathname;
  const {error}=await supabaseClient.auth.signInWithOAuth({
    provider:"google",
    options:{redirectTo,queryParams:{access_type:"offline",prompt:"select_account"}}
  });
  if(error){console.error("SBBL Google OAuth:",error);toast("Login Google gagal: "+error.message);if(button){button.disabled=false;button.innerHTML='<span class="google-g">G</span> Masuk dengan Google'}}
}

async function logout(){
  if(supabaseClient){const {error}=await supabaseClient.auth.signOut();if(error)console.error(error)}
  currentUser=null;currentProfile=null;showOnly("authScreen");
}

async function fetchOwnProfile(userId){
  let lastError=null;
  // The auth trigger normally creates the profile immediately. Retry briefly
  // to handle the first-login transaction completing just after OAuth returns.
  for(let attempt=0;attempt<4;attempt++){
    const {data,error}=await supabaseClient.from("profiles").select("*").eq("id",userId).maybeSingle();
    if(error){lastError=error;break;}
    if(data)return {profile:data,error:null};
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  return {profile:null,error:lastError};
}

async function handleSession(session){
  const run=++authRun;
  if(!session?.user){currentUser=null;currentProfile=null;showOnly("authScreen");const b=$("googleLogin");if(b){b.disabled=false;b.innerHTML='<span class="google-g">G</span> Masuk dengan Google'}return}
  currentUser=session.user;
  showOnly("authScreen");
  const {profile,error}=await fetchOwnProfile(currentUser.id);
  if(run!==authRun)return;
  console.info("SBBL login profile:",{email:currentUser.email,status:profile?.status,role:profile?.role,error:error?.message||null});
  if(error){
    console.error("SBBL profile query:",error);
    showOnly("blockedScreen");
    setText("blockedMessage","Profil akun gagal dibaca dari database: "+error.message+". Periksa kebijakan RLS pada tabel profiles.");
    return;
  }
  if(!profile){
    showOnly("blockedScreen");
    setText("blockedMessage","Profil akun belum terbentuk di database. Jalankan file supabase/auto-approve-login.sql di SQL Editor Supabase, lalu coba login kembali.");
    return;
  }
  currentProfile=profile;
  if(profile.status==="pending"){
    showOnly("waitingScreen");
    setText("waitingScreenMessage","Akun belum diaktifkan. Jalankan pembaruan login otomatis di Supabase, lalu keluar dan login kembali.");
    return;
  }
  if(profile.status!=="approved"){
    showOnly("blockedScreen");
    setText("blockedMessage",profile.status==="suspended"?"Akun kamu dinonaktifkan oleh pengelola.":"Akun kamu tidak memiliki akses. Hubungi Super Admin.");
    return;
  }
  showOnly("appShell");
  renderIdentity();applyRoleUI();
  try{await loadAll();await loadNotifications();}
  catch(err){console.error("SBBL dashboard load:",err);toast("Login berhasil, tetapi sebagian data gagal dimuat: "+(err.message||err));}
}

function renderIdentity(){
  setText("userName",currentProfile.full_name||currentUser.email);setText("userRole",currentProfile.role.replace("_"," ").toUpperCase());
  setText("settingsEmail",currentUser.email);setText("settingsRole",currentProfile.role.toUpperCase());
  $("userAvatar").src=currentProfile.avatar_url||"https://ui-avatars.com/api/?background=203b5c&color=fff&name=SBBL";
}
function applyRoleUI(){
  document.querySelectorAll(".admin-only").forEach(el=>el.classList.toggle("hidden",!isManager()));
  document.querySelectorAll(".nav-link").forEach(el=>{if(["members","categories","audit"].includes(el.dataset.page))el.classList.toggle("hidden",!isManager())});
}
async function loadAll(){await Promise.all([loadCategories(),loadTransactions()]);await loadDashboard();await renderReport();if(isManager()){await loadMembers(activeMemberStatus);await loadAudit()}}
async function loadCategories(){
  const {data,error}=await supabaseClient.from("categories").select("id,name,type,is_active").eq("is_active",true).order("name");
  if(error){console.error(error);return}categories=data||[];
  $("txCategory").innerHTML=categories.map(c=>`<option value="${c.id}">${safe(c.name)} (${c.type==="income"?"Pemasukan":"Pengeluaran"})</option>`).join("");
  renderCategories();
}
async function loadTransactions(){
  const {data,error}=await supabaseClient.from("transactions").select("id,transaction_date,description,counterparty,category_id,type,amount,payment_method,status,categories(name)").eq("status","active").order("transaction_date",{ascending:false}).order("created_at",{ascending:false}).limit(1000);
  if(error){console.error(error);toast("Tidak dapat memuat transaksi: "+error.message);return}
  transactions=data||[];renderTransactionTable();renderRecent();
}
function renderTransactionTable(){
  const q=$("transactionSearch").value.toLowerCase(),type=$("transactionTypeFilter").value,month=$("transactionMonthFilter").value;
  const rows=transactions.filter(t=>(!q||`${t.description} ${t.counterparty||""}`.toLowerCase().includes(q))&&(type==="all"||t.type===type)&&(!month||t.transaction_date.startsWith(month)));
  $("transactionRows").innerHTML=rows.length?rows.map(transactionRow).join(""):`<tr><td colspan="6" class="empty-cell">Tidak ada transaksi pada filter ini.</td></tr>`;
}
function transactionRow(t){return `<tr><td>${dateID(t.transaction_date)}</td><td><b>${safe(t.description)}</b></td><td>${safe(t.counterparty||"-")}</td><td>${safe(t.categories?.name||"-")}</td><td><span class="type-pill ${t.type==="income"?"income-pill":"expense-pill"}">${t.type==="income"?"Pemasukan":"Pengeluaran"}</span></td><td class="${t.type==="income"?"positive":"negative"}"><b>${t.type==="income"?"+":"−"} ${rupiah(t.amount)}</b></td></tr>`}
function renderRecent(){
  const recent=transactions.slice(0,6);
  $("recentRows").innerHTML=recent.length?recent.map(t=>`<tr><td>${dateID(t.transaction_date)}</td><td><b>${safe(t.description)}</b></td><td>${safe(t.categories?.name||"-")}</td><td><span class="type-pill ${t.type==="income"?"income-pill":"expense-pill"}">${t.type==="income"?"Pemasukan":"Pengeluaran"}</span></td><td><b>${rupiah(t.amount)}</b></td></tr>`).join(""):`<tr><td colspan="5" class="empty-cell">Belum ada transaksi.</td></tr>`;
}
async function loadDashboard(){
  const month=monthNow(),start=monthStart(month),end=nextMonth(month);
  const {data:setting}=await supabaseClient.from("system_settings").select("value").eq("key","opening_balance").maybeSingle();
  const opening=Number(setting?.value?.amount||0);
  const incomeAll=transactions.filter(t=>t.type==="income").reduce((s,t)=>s+Number(t.amount),0);
  const expenseAll=transactions.filter(t=>t.type==="expense").reduce((s,t)=>s+Number(t.amount),0);
  const incomeMonth=transactions.filter(t=>t.type==="income"&&t.transaction_date>=start&&t.transaction_date<end).reduce((s,t)=>s+Number(t.amount),0);
  const expenseMonth=transactions.filter(t=>t.type==="expense"&&t.transaction_date>=start&&t.transaction_date<end).reduce((s,t)=>s+Number(t.amount),0);
  setText("balanceValue",rupiah(opening+incomeAll-expenseAll));setText("incomeValue",rupiah(incomeMonth));setText("expenseValue",rupiah(expenseMonth));
  setText("transactionCount",transactions.filter(t=>t.transaction_date>=start&&t.transaction_date<end).length);
  setText("donutTotal",rupiah(incomeMonth+expenseMonth));
  const total=incomeMonth+expenseMonth,deg=total?incomeMonth/total*360:0;$("donut").style.background=`conic-gradient(var(--teal-dark) ${deg}deg,#e9edf3 ${deg}deg)`;
  renderChart();
}
function renderChart(){
  const months=[];const now=new Date();
  for(let i=5;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);months.push({key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`,label:d.toLocaleDateString("id-ID",{month:"short"})})}
  const values=months.map(m=>({ ...m,income:transactions.filter(t=>t.transaction_date.startsWith(m.key)&&t.type==="income").reduce((s,t)=>s+Number(t.amount),0),expense:transactions.filter(t=>t.transaction_date.startsWith(m.key)&&t.type==="expense").reduce((s,t)=>s+Number(t.amount),0)}));
  const max=Math.max(1,...values.flatMap(v=>[v.income,v.expense]));const W=620,H=210,base=175,top=15,barW=22,gap=22;
  let svg=`<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafik pemasukan dan pengeluaran enam bulan">`;
  [0,1,2,3].forEach(i=>{const y=top+i*50;svg+=`<line x1="35" y1="${y}" x2="610" y2="${y}" stroke="#edf0f5" stroke-width="1"/>`});
  values.forEach((v,i)=>{const x=58+i*91,ih=v.income/max*145,eh=v.expense/max*145;svg+=`<rect x="${x}" y="${base-ih}" width="${barW}" height="${ih}" rx="5" fill="#269d83"/><rect x="${x+barW+5}" y="${base-eh}" width="${barW}" height="${eh}" rx="5" fill="#e7a0a5"/><text x="${x+24}" y="198" text-anchor="middle" font-size="10" fill="#8793a7">${v.label}</text>`});
  svg+="</svg>";$("cashChart").innerHTML=svg;
}
async function renderReport(){
  const month=$("reportMonth").value||monthNow(),start=monthStart(month),end=nextMonth(month);
  const {data:setting}=await supabaseClient.from("system_settings").select("value").eq("key","opening_balance").maybeSingle();
  const openingBase=Number(setting?.value?.amount||0);
  const prior=transactions.filter(t=>t.transaction_date<start);
  const opening=openingBase+prior.reduce((s,t)=>s+(t.type==="income"?1:-1)*Number(t.amount),0);
  const period=transactions.filter(t=>t.transaction_date>=start&&t.transaction_date<end);
  const income=period.filter(t=>t.type==="income").reduce((s,t)=>s+Number(t.amount),0);
  const expense=period.filter(t=>t.type==="expense").reduce((s,t)=>s+Number(t.amount),0);
  setText("reportOpening",rupiah(opening));setText("reportIncome",rupiah(income));setText("reportExpense",rupiah(expense));setText("reportClosing",rupiah(opening+income-expense));
  $("reportRows").innerHTML=period.length?period.map(t=>`<tr><td>${dateID(t.transaction_date)}</td><td>${safe(t.description)}</td><td>${t.type==="income"?"Pemasukan":"Pengeluaran"}</td><td>${rupiah(t.amount)}</td></tr>`).join(""):`<tr><td colspan="4" class="empty-cell">Tidak ada transaksi pada periode ini.</td></tr>`;
}
async function saveTransaction(e){
  e.preventDefault();if(!isManager())return toast("Akses ditolak.");
  const type=$("txType").value,amount=Number($("txAmount").value),categoryId=$("txCategory").value;
  if(!Number.isSafeInteger(amount)||amount<=0)return toast("Nominal harus berupa bilangan Rupiah positif.");
  const category=categories.find(c=>c.id===categoryId);if(!category||category.type!==type)return toast("Kategori tidak sesuai dengan jenis transaksi.");
  const payload={transaction_date:$("txDate").value,description:$("txDescription").value.trim(),counterparty:$("txCounterparty").value.trim()||null,category_id:categoryId,type,amount,payment_method:$("txMethod").value,notes:$("txNotes").value.trim()||null};
  const {error}=await supabaseClient.rpc("create_transaction", {p_transaction:payload});
  if(error){console.error(error);return toast("Transaksi gagal disimpan: "+error.message)}
  $("transactionDialog").close();$("transactionForm").reset();$("txDate").value=new Date().toISOString().slice(0,10);
  toast("Transaksi berhasil disimpan.");await loadAll();
}
async function loadMembers(status){
  if(!isManager())return;
  const {data,error}=await supabaseClient.from("profiles").select("id,full_name,email,role,status,created_at").eq("status",status).order("created_at",{ascending:false});
  if(error){console.error(error);$("memberRows").innerHTML=`<tr><td colspan="5" class="empty-cell">Tidak dapat memuat anggota.</td></tr>`;return}
  $("memberRows").innerHTML=data.length?data.map(p=>{
    let actions="-";
    if(status==="pending") actions=`<button class="action-button approve" data-member-action="approve" data-id="${p.id}">Setujui</button><button class="action-button reject" data-member-action="reject" data-id="${p.id}">Tolak</button>`;
    else if(status==="approved"&&p.role==="member") actions=`<button class="action-button reject" data-member-action="suspend" data-id="${p.id}">Nonaktifkan</button>${isSuper()?` <button class="action-button approve" data-member-action="make-admin" data-id="${p.id}">Jadikan Admin</button>`:""}`;
    else if(status==="approved"&&p.role==="admin"&&isSuper()) actions=`<button class="action-button reject" data-member-action="remove-admin" data-id="${p.id}">Turunkan ke Anggota</button>`;
    else if(status==="suspended"||status==="rejected") actions=`<button class="action-button approve" data-member-action="approve" data-id="${p.id}">Aktifkan</button>`;
    return `<tr><td><b>${safe(p.full_name||"Tanpa nama")}</b></td><td>${safe(p.email)}</td><td>${safe(p.role)}</td><td>${safe(p.status)}</td><td>${actions}</td></tr>`
  }).join(""):`<tr><td colspan="5" class="empty-cell">Tidak ada anggota pada status ini.</td></tr>`;
}
async function memberAction(id,action){
  if(!isManager())return toast("Akses ditolak.");
  if(["make-admin","remove-admin"].includes(action)){
    if(!isSuper())return toast("Hanya Super Admin yang dapat mengatur Admin.");
    const makeAdmin=action==="make-admin";
    if(!confirm(makeAdmin?"Jadikan akun ini Admin? Maksimal 4 Admin biasa.":"Turunkan Admin ini menjadi Anggota?"))return;
    const {error}=await supabaseClient.rpc("set_admin_role",{p_user_id:id,p_make_admin:makeAdmin});
    if(error)return toast("Perubahan role gagal: "+error.message);
    toast("Role akun berhasil diperbarui.");await loadMembers(activeMemberStatus);return;
  }
  let reason="";
  if(["reject","suspend"].includes(action)){reason=prompt("Masukkan alasan tindakan (wajib):")||"";if(!reason.trim())return toast("Alasan wajib diisi.");}
  const {error}=await supabaseClient.rpc("manage_member",{p_user_id:id,p_action:action,p_reason:reason});
  if(error)return toast("Tindakan gagal: "+error.message);
  toast("Status anggota berhasil diperbarui.");await loadMembers(activeMemberStatus);
}
async function loadAudit(){
  if(!isManager())return;
  const {data,error}=await supabaseClient.from("audit_logs").select("id,created_at,actor_email,action,entity,details").order("created_at",{ascending:false}).limit(100);
  if(error){console.error(error);return}
  $("auditRows").innerHTML=data.length?data.map(a=>`<tr><td>${new Date(a.created_at).toLocaleString("id-ID")}</td><td>${safe(a.actor_email||"-")}</td><td>${safe(a.action)}</td><td>${safe(a.entity)}</td><td>${safe(JSON.stringify(a.details||{}))}</td></tr>`).join(""):`<tr><td colspan="5" class="empty-cell">Belum ada aktivitas.</td></tr>`;
}
function renderCategories(){
  $("categoryRows").innerHTML=categories.length?categories.map(c=>`<tr><td><b>${safe(c.name)}</b></td><td>${c.type==="income"?"Pemasukan":"Pengeluaran"}</td><td><span class="status-pill active-pill">Aktif</span></td></tr>`).join(""):`<tr><td colspan="3" class="empty-cell">Belum ada kategori.</td></tr>`;
}
async function saveCategory(e){
  e.preventDefault();if(!isManager())return;
  const name=$("categoryName").value.trim(),type=$("categoryType").value;
  const {error}=await supabaseClient.from("categories").insert({name,type});
  if(error)return toast("Gagal menambah kategori: "+error.message);
  $("categoryDialog").close();$("categoryForm").reset();await loadCategories();toast("Kategori berhasil ditambahkan.");
}
async function loadNotifications(){
  if(!supabaseClient||!currentUser)return;
  const {data,error}=await supabaseClient.from("notifications").select("id,title,body,type,created_at,read_at").eq("recipient_id",currentUser.id).order("created_at",{ascending:false}).limit(50);
  if(error){console.warn("Notifications not available yet:",error.message);return;}
  notifications=data||[];
  const unread=notifications.filter(n=>!n.read_at).length;
  const badge=$("notificationBadge");if(badge){badge.textContent=unread>99?"99+":String(unread);badge.classList.toggle("hidden",unread===0)}
  const list=$("notificationList");if(!list)return;
  list.innerHTML=notifications.length?notifications.map(n=>`<article class="notification-item ${n.read_at?"":"unread"}"><div class="notification-item-top"><strong>${safe(n.title)}</strong><small>${new Date(n.created_at).toLocaleString("id-ID")}</small></div><p>${safe(n.body)}</p></article>`).join(""):'<p class="muted">Belum ada notifikasi.</p>';
}
async function markAllNotificationsRead(){
  const ids=notifications.filter(n=>!n.read_at).map(n=>n.id);if(!ids.length)return toast("Tidak ada notifikasi baru.");
  const {error}=await supabaseClient.rpc("mark_my_notifications_read",{p_ids:ids});
  if(error)return toast("Gagal memperbarui notifikasi: "+error.message);
  await loadNotifications();toast("Semua notifikasi ditandai sudah dibaca.");
}
async function sendAnnouncement(event){
  event.preventDefault();if(!isManager())return toast("Akses ditolak.");
  const title=$("announcementTitle").value.trim(),body=$("announcementBody").value.trim();if(!title||!body)return;
  const {data:members,error:memberError}=await supabaseClient.from("profiles").select("id").eq("status","approved");
  if(memberError)return toast("Gagal mengambil daftar anggota: "+memberError.message);
  const rows=(members||[]).map(m=>({recipient_id:m.id,title,body,type:"announcement",created_by:currentUser.id}));
  if(!rows.length)return toast("Belum ada anggota yang disetujui.");
  const {error}=await supabaseClient.from("notifications").insert(rows);
  if(error)return toast("Pengumuman gagal dikirim: "+error.message);
  $("announcementDialog").close();$("announcementForm").reset();await loadNotifications();toast(`Pengumuman berhasil dikirim ke ${rows.length} akun.`);
}

function bindUI(){
  document.querySelectorAll(".nav-link").forEach(btn=>btn.addEventListener("click",()=>navigate(btn.dataset.page)));
  document.querySelectorAll("[data-goto]").forEach(btn=>btn.addEventListener("click",()=>navigate(btn.dataset.goto)));
  document.querySelectorAll("[data-close]").forEach(btn=>btn.addEventListener("click",()=>$(btn.dataset.close).close()));
  $("menuToggle").addEventListener("click",()=>$("sidebar").classList.toggle("open"));
  $("notificationBell")?.addEventListener("click",async()=>{$("notificationDialog").showModal();await loadNotifications();});
  $("markAllNotifications")?.addEventListener("click",markAllNotificationsRead);
  $("openAnnouncement")?.addEventListener("click",()=>{if(isManager())$("announcementDialog").showModal()});
  $("announcementForm")?.addEventListener("submit",sendAnnouncement);
  $("addTransaction").addEventListener("click",()=>{$("transactionDialog").showModal()});
  $("transactionForm").addEventListener("submit",saveTransaction);
  $("txType").addEventListener("change",()=>setText("counterpartyLabel", $("txType").value==="income"?"Nama pembayar / sumber pemasukan":"Penerima / tujuan pengeluaran"));
  $("transactionSearch").addEventListener("input",renderTransactionTable);$("transactionTypeFilter").addEventListener("change",renderTransactionTable);$("transactionMonthFilter").addEventListener("change",renderTransactionTable);
  $("reportMonth").addEventListener("change",renderReport);
  $("addCategory").addEventListener("click",()=>$("categoryDialog").showModal());$("categoryForm").addEventListener("submit",saveCategory);
  $("memberRows").addEventListener("click",e=>{const b=e.target.closest("[data-member-action]");if(b)memberAction(b.dataset.id,b.dataset.memberAction)});
  document.querySelectorAll("[data-member-status]").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll("[data-member-status]").forEach(x=>x.classList.toggle("active",x===b));activeMemberStatus=b.dataset.memberStatus;loadMembers(activeMemberStatus)}));
  $("exportCsv").addEventListener("click",exportReportCsv);$("printReport").addEventListener("click",()=>window.print());
}
function navigate(page){
  if(["members","categories","audit"].includes(page)&&!isManager())return toast("Kamu tidak memiliki akses ke menu ini.");
  document.querySelectorAll(".page").forEach(p=>p.classList.add("hidden"));$(page+"Page").classList.remove("hidden");
  document.querySelectorAll(".nav-link").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  const names={dashboard:"Dashboard",transactions:"Transactions",reports:"Reports",data:"Data Sources",scheduled:"Scheduled",members:"Members",categories:"Categories",audit:"Audit Log",settings:"Settings"};
  setText("pageHeading",names[page]||"Dashboard");$("sidebar").classList.remove("open");
  if(page==="reports")renderReport();if(page==="members")loadMembers(activeMemberStatus);if(page==="audit")loadAudit();
}
function exportReportCsv(){
  const month=$("reportMonth").value||monthNow(),start=monthStart(month),end=nextMonth(month);
  const period=transactions.filter(t=>t.transaction_date>=start&&t.transaction_date<end);
  const rows=[["Tanggal","Keterangan","Jenis","Nominal","Sumber/Tujuan","Kategori"],...period.map(t=>[t.transaction_date,t.description,t.type,t.amount,t.counterparty||"",t.categories?.name||""])];
  const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\r\n");
  const blob=new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`SBBL-Laporan-${month}.csv`;a.click();URL.revokeObjectURL(url);
}
init();
