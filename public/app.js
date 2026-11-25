const $ = id => document.getElementById(id);
const money = n => new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(n || 0);
const today = new Date();
const indiaDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const thisMonth = indiaDate().slice(0,7);
$("monthPicker").value = thisMonth;
$("budgetMonth").value = thisMonth;
$("transactionDate").value = indiaDate();
let transactions = [], budgets = [], goals = [], categoryChart, flowChart;

async function api(url, options={}) {
  const response = await fetch(url,{...options,credentials:"same-origin",headers:{"Content-Type":"application/json",...(options.headers||{})}});
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith("/api/auth/")) showAuthScreen("Your session has ended. Please log in again.");
    throw new Error(data.error || "Request failed");
  }
  return data;
}
function notify(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  setTimeout(() => $("toast").classList.remove("show"), 2600);
}
function safe(value) {
  return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function openDialog(id) { $(id).showModal(); }
function closeDialog(id) { $(id).close(); }

function showAuthScreen(message="") {
  $("appShell").hidden = true;
  $("authScreen").hidden = false;
  $("authMessage").textContent = message;
}
function showAuthMode(mode) {
  const signup = mode === "signup";
  $("loginForm").hidden = signup;
  $("signupForm").hidden = !signup;
  $("authTitle").textContent = signup ? "Create your account" : "Welcome back";
  $("authSubtitle").textContent = signup ? "Create an account to keep your finances private and organized." : "Log in to access your personal finance dashboard.";
  $("authMessage").textContent = "";
}
function enterDashboard(user) {
  $("authScreen").hidden = true;
  $("appShell").hidden = false;
  $("accountName").textContent = user.name;
  $("accountName").title = user.email;
  refreshAll();
}
$("showSignup").addEventListener("click",()=>showAuthMode("signup"));
$("showLogin").addEventListener("click",()=>showAuthMode("login"));
$("loginForm").addEventListener("submit",async e=>{
  e.preventDefault(); const data=Object.fromEntries(new FormData(e.target));
  const button=e.target.querySelector("button[type=submit]"); button.disabled=true; button.textContent="Logging in...";
  try { const result=await api("/api/auth/login",{method:"POST",body:JSON.stringify(data)}); e.target.reset(); enterDashboard(result.user); }
  catch(error) { $("authMessage").textContent=error.message; }
  finally { button.disabled=false; button.textContent="Log in"; }
});
$("signupForm").addEventListener("submit",async e=>{
  e.preventDefault(); const data=Object.fromEntries(new FormData(e.target));
  const button=e.target.querySelector("button[type=submit]"); button.disabled=true; button.textContent="Creating account...";
  try { const result=await api("/api/auth/signup",{method:"POST",body:JSON.stringify(data)}); e.target.reset(); enterDashboard(result.user); }
  catch(error) { $("authMessage").textContent=error.message; }
  finally { button.disabled=false; button.textContent="Create account"; }
});
$("logoutBtn").addEventListener("click",async()=>{
  try { await api("/api/auth/logout",{method:"POST"}); showAuthMode("login"); showAuthScreen("You have been logged out."); }
  catch(error) { notify(error.message); }
});

async function refreshAll() {
  try {
    [transactions,budgets,goals] = await Promise.all([
      api("/api/transactions"),api("/api/budgets"),api("/api/goals")
    ]);
    await refreshSummary();
    renderTransactions(); renderBudgets(); renderGoals();
  } catch (error) { notify(error.message); }
}
async function refreshSummary() {
  const month = $("monthPicker").value || thisMonth;
  const s = await api("/api/summary?month=" + encodeURIComponent(month));
  $("income").textContent = money(s.income);
  $("expenses").textContent = money(s.expenses);
  $("balance").textContent = money(s.balance);
  $("balance").className = s.balance >= 0 ? "positive" : "negative";
  $("savingsRate").textContent = s.savingsRate + "%";
  $("chartMonth").textContent = month;
  drawCharts(s);
}
function drawCharts(summary) {
  const labels = summary.categories.map(c => c.name);
  $("chartEmpty").style.display = labels.length ? "none" : "block";
  $("categoryChart").style.display = labels.length ? "block" : "none";
  if (categoryChart) categoryChart.destroy();
  if (labels.length) {
    categoryChart = new Chart($("categoryChart"), {
      type:"doughnut",
      data:{labels,datasets:[{data:summary.categories.map(c=>c.amount),backgroundColor:["#43d6a5","#809dff","#f5c76b","#ff7185","#b28cff","#53c5dc","#e69c72","#8ba5bd"],borderColor:"#121b30",borderWidth:4}]},
      options:{maintainAspectRatio:false,plugins:{legend:{position:"bottom",labels:{color:"#aab8d0",boxWidth:10,padding:14}}}}
    });
  }
  const months = [];
  for (let i=5;i>=0;i--) { const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()-i); months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`); }
  const income=months.map(m=>transactions.filter(t=>t.type==="income"&&t.date.startsWith(m)).reduce((a,t)=>a+t.amount,0));
  const expenses=months.map(m=>transactions.filter(t=>t.type==="expense"&&t.date.startsWith(m)).reduce((a,t)=>a+t.amount,0));
  if (flowChart) flowChart.destroy();
  flowChart = new Chart($("flowChart"), {
    type:"bar",
    data:{labels:months.map(m=>new Date(m+"-02").toLocaleDateString("en-IN",{month:"short"})),datasets:[{label:"Income",data:income,backgroundColor:"#43d6a5",borderRadius:5},{label:"Expenses",data:expenses,backgroundColor:"#ff7185",borderRadius:5}]},
    options:{maintainAspectRatio:false,scales:{x:{ticks:{color:"#91a0bb"},grid:{display:false}},y:{ticks:{color:"#91a0bb",callback:v=>"₹"+v.toLocaleString("en-IN")},grid:{color:"#273550"}}},plugins:{legend:{labels:{color:"#aab8d0",boxWidth:10}}}}
  });
}
function renderTransactions() {
  const month=$("monthPicker").value;
  const items=transactions.filter(t=>t.date.startsWith(month)).slice(0,15);
  $("transactionEmpty").style.display=items.length?"none":"block";
  $("transactionRows").innerHTML=items.map(t=>`<tr><td><strong>${safe(t.title)}</strong><div class="muted">${safe(t.note||"")}</div></td><td><span class="tag">${safe(t.category)}</span></td><td>${safe(t.date)}</td><td class="amount ${t.type==="income"?"positive":"negative"}">${t.type==="income"?"+":"−"}${money(t.amount)}</td><td><button class="delete" title="Delete transaction" data-delete-transaction="${safe(t.id)}">×</button></td></tr>`).join("");
}
function renderBudgets() {
  const month=$("monthPicker").value, items=budgets.filter(b=>b.month===month);
  if (!items.length) { $("budgetList").innerHTML='<p class="empty-item">No budgets for this month yet.</p>'; return; }
  $("budgetList").innerHTML=items.map(b=>{
    const spent=transactions.filter(t=>t.type==="expense"&&t.category.toLowerCase()===b.category.toLowerCase()&&t.date.startsWith(month)).reduce((s,t)=>s+t.amount,0);
    const pct=Math.min(100,spent/b.limit*100);
    return `<div class="budget-item"><div class="between"><strong>${safe(b.category)}</strong><span>${money(spent)} / ${money(b.limit)}</span></div><div class="track"><div class="fill ${spent>b.limit?"over":""}" style="width:${pct}%"></div></div><div class="between muted"><span>${Math.round(spent/b.limit*100)}% used</span><button class="delete" data-delete-budget="${safe(b.id)}">Remove</button></div></div>`;
  }).join("");
}
function renderGoals() {
  if (!goals.length) { $("goalList").innerHTML='<p class="empty-item">Create a goal and track your progress.</p>'; return; }
  $("goalList").innerHTML=goals.map(g=>{
    const pct=Math.min(100,g.saved/g.target*100);
    return `<div class="goal-item"><div class="between"><strong>${safe(g.name)}</strong><span>${Math.round(pct)}%</span></div><div class="track"><div class="fill" style="width:${pct}%"></div></div><div class="between muted"><span>${money(g.saved)} of ${money(g.target)}</span><span class="mini-actions"><button class="mini-button" data-contribute="${safe(g.id)}">＋ Add</button><button class="delete" data-delete-goal="${safe(g.id)}">×</button></span></div></div>`;
  }).join("");
}
$("transactionRows").addEventListener("click", async e=>{
  const btn=e.target.closest("[data-delete-transaction]"); if(!btn)return;
  if(!confirm("Delete this transaction?"))return;
  try{await api("/api/transactions/"+btn.dataset.deleteTransaction,{method:"DELETE"});notify("Transaction deleted");refreshAll()}catch(err){notify(err.message)}
});
$("budgetList").addEventListener("click",async e=>{
  const btn=e.target.closest("[data-delete-budget]");if(!btn)return;
  try{await api("/api/budgets/"+btn.dataset.deleteBudget,{method:"DELETE"});notify("Budget removed");refreshAll()}catch(err){notify(err.message)}
});
$("goalList").addEventListener("click",async e=>{
  const add=e.target.closest("[data-contribute]");
  const del=e.target.closest("[data-delete-goal]");
  if(add){const amount=prompt("Contribution amount (₹):");if(amount===null)return;try{await api("/api/goals/"+add.dataset.contribute,{method:"PATCH",body:JSON.stringify({amount:Number(amount)})});notify("Contribution added");refreshAll()}catch(err){notify(err.message)}}
  if(del){if(!confirm("Delete this savings goal?"))return;try{await api("/api/goals/"+del.dataset.deleteGoal,{method:"DELETE"});notify("Goal deleted");refreshAll()}catch(err){notify(err.message)}}
});
$("transactionForm").addEventListener("submit",async e=>{
  e.preventDefault();const data=Object.fromEntries(new FormData(e.target));
  try{await api("/api/transactions",{method:"POST",body:JSON.stringify(data)});e.target.reset();$("transactionDate").value=indiaDate();closeDialog("transactionDialog");notify("Transaction added");refreshAll()}catch(err){notify(err.message)}
});
$("budgetForm").addEventListener("submit",async e=>{
  e.preventDefault();const data=Object.fromEntries(new FormData(e.target));
  try{await api("/api/budgets",{method:"POST",body:JSON.stringify(data)});closeDialog("budgetDialog");notify("Budget saved");refreshAll()}catch(err){notify(err.message)}
});
$("goalForm").addEventListener("submit",async e=>{
  e.preventDefault();const data=Object.fromEntries(new FormData(e.target));
  try{await api("/api/goals",{method:"POST",body:JSON.stringify(data)});e.target.reset();closeDialog("goalDialog");notify("Savings goal created");refreshAll()}catch(err){notify(err.message)}
});
$("addTransactionBtn").onclick=()=>openDialog("transactionDialog");
$("addBudgetBtn").onclick=()=>openDialog("budgetDialog");
$("addGoalBtn").onclick=()=>openDialog("goalDialog");
$("refreshBtn").onclick=refreshAll;
$("monthPicker").addEventListener("change",()=>{refreshSummary();renderTransactions();renderBudgets()});
document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>closeDialog(b.dataset.close)));

function addChatMessage(role, text) {
  const div=document.createElement("div");div.className="chat-message "+role;
  const label=document.createElement("b");label.textContent=role==="user"?"You":"FinTrack Assistant";
  const p=document.createElement("p");p.textContent=text;
  div.append(label,p);$("chatLog").append(div);$("chatLog").scrollTop=$("chatLog").scrollHeight;
}
async function sendChat(message) {
  const question=message.trim();if(!question)return;
  addChatMessage("user",question);$("chatInput").value="";$("chatSend").disabled=true;$("chatSend").textContent="...";
  try{const result=await api("/api/chat",{method:"POST",body:JSON.stringify({message:question})});addChatMessage("assistant",result.reply)}
  catch(err){addChatMessage("assistant","Sorry, I couldn't process that. "+err.message)}
  finally{$("chatSend").disabled=false;$("chatSend").textContent="Send";$("chatInput").focus()}
}
$("chatForm").addEventListener("submit",e=>{e.preventDefault();sendChat($("chatInput").value)});
document.querySelectorAll(".suggestion").forEach(b=>b.addEventListener("click",()=>sendChat(b.textContent)));
(async function bootstrap(){
  try { const result=await api("/api/auth/me"); enterDashboard(result.user); }
  catch { showAuthMode("login"); showAuthScreen(); }
})();


// Hybrid ML dashboard
function renderMlInsights(data) {
  $("mlProfile").textContent = data.spending_profile || "Not enough data";
  const m=data.metrics||{};
  $("mlMetrics").textContent = `Classifier F1 ${m.categorisation_macro_f1 ?? "—"} · Forecast MAE ₹${Number(m.forecast_model_mae_inr||0).toLocaleString("en-IN")} vs baseline ₹${Number(m.forecast_baseline_mae_inr||0).toLocaleString("en-IN")}`;
  const ds=data.data_summary||{};
  $("mlData").textContent = `${ds.user_expense_transactions||0} personal expenses · ${ds.months_with_expenses||0} months`;
  const forecast=data.forecast||[];
  $("mlForecast").innerHTML = forecast.length
    ? forecast.map(x=>`<div class="ml-result-row"><span>${safe(x.category)}<small>3-month average ${money(x.baseline_amount)}</small></span><strong>${money(x.predicted_amount)}</strong></div>`).join("")
    : `<p class="muted">${safe(data.forecast_note||"Add more transaction history for a personalised forecast.")}</p>`;
  const categoryRows=data.category_predictions||[];
  $("mlCategories").innerHTML = categoryRows.length
    ? categoryRows.slice(0,12).map(x=>`<div class="ml-result-row"><span>${safe(x.title)}<small>Actual: ${safe(x.actual_category)} · Predicted: ${safe(x.predicted_category)}</small></span><strong>${Math.round(x.confidence*100)}%</strong></div>`).join("")
    : `<p class="muted">Add expense titles to see model category predictions.</p>`;
  const anomalies=data.anomalies||[];
  $("mlAnomalies").innerHTML = anomalies.length
    ? anomalies.map(x=>`<div class="ml-result-row anomaly"><span><b>${safe(x.title)}</b><small>${safe(x.category)} · ${safe(x.date)} · ${safe(x.reason)}</small></span><strong>${money(x.amount)}</strong></div>`).join("")
    : `<p class="muted">No transactions were flagged by the current model. This does not guarantee that all transactions are normal.</p>`;
  const recs=data.budget_recommendations||[];
  $("mlBudgets").innerHTML = recs.length
    ? recs.map(x=>`<div class="ml-result-row"><span>${safe(x.category)}<small>Recent average ${money(x.recent_average)}</small></span><strong>${money(x.suggested_limit)}</strong></div>`).join("")
    : `<p class="muted">Add at least two months of transactions to receive personalised budget suggestions.</p>`;
  const fm=data.forecast_metrics||{};
  $("mlError").textContent = `Classifier metrics are from held-out synthetic descriptions. Forecast validation: model MAE ₹${Number(fm.model_mae_inr||0).toLocaleString("en-IN")} vs 3-month-average baseline ₹${Number(fm.baseline_mae_inr||0).toLocaleString("en-IN")} on held-out synthetic users. These are not personal accuracy guarantees.`;
}
async function runMlAnalysis() {
  const button=$("runMlBtn");
  button.disabled=true; button.textContent="Training models...";
  $("mlError").textContent="";
  try {
    const result=await api("/api/ml/insights");
    renderMlInsights(result);
    notify("ML analysis completed");
  } catch(err) { $("mlError").textContent=err.message; }
  finally { button.disabled=false; button.textContent="Run ML analysis"; }
}
if ($("runMlBtn")) $("runMlBtn").addEventListener("click",runMlAnalysis);
