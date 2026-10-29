'use strict';
/* Tally - music finance tracker (file-backed PWA) */

const LS_KEY = 'tally-data-v1';
const FMT = new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD'});
const money = n => FMT.format(Number(n||0));
const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

let STATE = null;
let fileHandle = null;   // legacy single-file handle (fallback)
let dirHandle = null;    // workspace folder (Finance)
let dirty = false;
let editId = null;
const hasFS = ('showSaveFilePicker' in window);
const hasDir = ('showDirectoryPicker' in window);
const invFolder = () => (STATE && STATE.invoicesFolder) || 'Invoices';

/* ---------- tiny IndexedDB for the file handle ---------- */
const idb = {
  db:null,
  open(){ return new Promise(res=>{ const r=indexedDB.open('tally',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('kv');
    r.onsuccess=()=>{this.db=r.result;res();}; r.onerror=()=>res(); }); },
  async set(k,v){ try{ if(!this.db) await this.open(); return new Promise(res=>{
    const t=this.db.transaction('kv','readwrite'); t.objectStore('kv').put(v,k); t.oncomplete=res; t.onerror=res; }); }catch(e){} },
  async get(k){ try{ if(!this.db) await this.open(); return new Promise(res=>{
    const t=this.db.transaction('kv','readonly'); const g=t.objectStore('kv').get(k);
    g.onsuccess=()=>res(g.result); g.onerror=()=>res(null); }); }catch(e){ return null; } }
};

/* ---------- boot ---------- */
window.addEventListener('DOMContentLoaded', init);
async function init(){
  wireTabs(); wireForms(); wireData();
  let data=null;
  try{ const raw=localStorage.getItem(LS_KEY); if(raw) data=JSON.parse(raw); }catch(e){}
  if(!data){
    try{ data=await (await fetch('seed.json',{cache:'no-store'})).json(); }
    catch(e){ data=blankState(); }
  }
  STATE=data;
  if(hasFS){ fileHandle=await idb.get('fileHandle'); }
  if(hasDir){ dirHandle=await idb.get('dirHandle'); }
  dirty = false;
  renderAll(); updateSaveState();
  if('serviceWorker' in navigator){ try{ navigator.serviceWorker.register('sw.js'); }catch(e){} }
}
function blankState(){ return {schema:1,appName:'Tally',year:new Date().getFullYear(),
  account:{code:'D5720',name:'Music',allocations:[]}, motions:[], invoices:[], ledger:[], ledgerMeta:{}}; }

/* ---------- persistence ---------- */
function cache(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(STATE)); }catch(e){} }
function markDirty(){ dirty=true; cache(); updateSaveState(); }
function updateSaveState(){
  const p=$('#saveState'); const linked = !!(dirHandle||fileHandle);
  if(dirty){ p.textContent='unsaved'; p.className='pill unsaved'; }
  else { p.textContent = linked? 'saved':'cache only'; p.className='pill '+(linked?'saved':''); }
  const ws=$('#wsStatus');
  if(ws) ws.textContent = dirHandle? ('Workspace: '+dirHandle.name+' / '+invFolder()+' (invoice files)') : 'No workspace folder chosen yet. Click "Choose Finance folder".';
}
async function ensurePerm(handle,write){
  if(!handle||!handle.queryPermission) return true;
  const opt={mode:write?'readwrite':'read'};
  if(await handle.queryPermission(opt)==='granted') return true;
  return (await handle.requestPermission(opt))==='granted';
}
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1900); }

async function saveToFile(){
  const json = JSON.stringify(STATE,null,1);
  // prefer the workspace folder
  if(dirHandle){
    try{
      if(await ensurePerm(dirHandle,true)){
        const fh=await dirHandle.getFileHandle('tally-data.json',{create:true});
        const w=await fh.createWritable(); await w.write(json); await w.close();
        dirty=false; updateSaveState(); toast('Saved to '+dirHandle.name); return;
      }
    }catch(e){ console.warn(e); }
  }
  if(hasFS){
    try{
      if(!fileHandle){
        fileHandle = await window.showSaveFilePicker({suggestedName:'tally-data.json',
          types:[{description:'Tally data',accept:{'application/json':['.json']}}]});
        await idb.set('fileHandle',fileHandle);
      }
      const w=await fileHandle.createWritable(); await w.write(json); await w.close();
      dirty=false; updateSaveState(); toast('Saved to file'); return;
    }catch(e){ if(e&&e.name==='AbortError') return; console.warn(e); }
  }
  const blob=new Blob([json],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='tally-data.json';
  a.click(); URL.revokeObjectURL(a.href);
  dirty=false; updateSaveState(); toast('Data file downloaded');
}

async function chooseWorkspace(){
  if(!hasDir){ toast('This browser cannot open a folder; use Open/Save file instead'); return; }
  try{
    const h=await window.showDirectoryPicker({mode:'readwrite'});
    if(!await ensurePerm(h,true)){ toast('Folder permission denied'); return; }
    dirHandle=h; await idb.set('dirHandle',h);
    // if the folder already has a tally-data.json, offer to load it
    let existing=null;
    try{ const fh=await h.getFileHandle('tally-data.json'); existing=JSON.parse(await (await fh.getFile()).text()); }catch(e){}
    if(existing && confirm('This folder already has a tally-data.json. Load it? (Cancel keeps what is on screen.)')){
      STATE=existing; dirty=false;
    } else {
      dirty=true; // need to write current state into the folder
    }
    renderAll(); updateSaveState();
    toast('Workspace set to '+h.name);
    if(dirty) saveToFile();
  }catch(e){ if(e&&e.name!=='AbortError') console.warn(e); }
}

async function resolveFile(path){
  if(!dirHandle) throw new Error('no-workspace');
  if(!await ensurePerm(dirHandle,false)) throw new Error('no-permission');
  const parts=path.split('/').filter(Boolean);
  let dir=dirHandle;
  for(let i=0;i<parts.length-1;i++){ dir=await dir.getDirectoryHandle(parts[i]); }
  const fh=await dir.getFileHandle(parts[parts.length-1]);
  return await fh.getFile();
}
async function openDoc(x){
  if(!dirHandle){ toast('Choose your Finance folder on the Data tab first'); return; }
  if(!x.file){ toast('No file linked. Use Attach.'); return; }
  try{
    const f=await resolveFile(x.file);
    const url=URL.createObjectURL(f);
    window.open(url,'_blank');
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  }catch(e){ console.warn(e); toast('Could not open '+x.file.split('/').pop()); }
}
function sanitize(s){ return String(s||'').replace(/[\\/:*?"<>|]/g,'-').replace(/\s+/g,' ').trim().slice(0,90); }
async function attachDoc(i){
  if(!dirHandle){ toast('Choose your Finance folder on the Data tab first'); return; }
  if(!hasFS){ toast('This browser cannot pick a file'); return; }
  let picked;
  try{ [picked]=await window.showOpenFilePicker({types:[{description:'Invoice',accept:{'application/pdf':['.pdf'],'image/*':['.png','.jpg','.jpeg']}}]}); }
  catch(e){ return; }
  try{
    if(!await ensurePerm(dirHandle,true)){ toast('Folder permission denied'); return; }
    const src=await picked.getFile();
    const ext=(src.name.match(/\.[a-z0-9]+$/i)||['.pdf'])[0];
    const x=STATE.invoices[i];
    const name=sanitize(`${x.date||''} - ${x.vendor||'invoice'} (${x.invoiceNo||''})`)+ext;
    const sub=await dirHandle.getDirectoryHandle(invFolder(),{create:true});
    const fh=await sub.getFileHandle(name,{create:true});
    const w=await fh.createWritable(); await w.write(await src.arrayBuffer()); await w.close();
    x.file=invFolder()+'/'+name;
    if(x.docStatus==='Missing') x.docStatus='Documented';
    markDirty(); renderAll(); toast('Attached '+name);
  }catch(e){ console.warn(e); toast('Could not attach file'); }
}
async function openFile(){
  if(hasFS){
    try{
      const [h]=await window.showOpenFilePicker({types:[{description:'Tally data',accept:{'application/json':['.json']}}]});
      fileHandle=h; await idb.set('fileHandle',h);
      const f=await h.getFile(); STATE=JSON.parse(await f.text());
      dirty=false; renderAll(); updateSaveState(); toast('Loaded '+f.name); return;
    }catch(e){ if(e&&e.name==='AbortError') return; console.warn(e); }
  }
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.json';
  inp.onchange=async()=>{ const f=inp.files[0]; if(!f) return; STATE=JSON.parse(await f.text());
    dirty=false; renderAll(); updateSaveState(); toast('Loaded '+f.name); };
  inp.click();
}

/* ---------- tabs ---------- */
function wireTabs(){
  $$('#tabs button').forEach(b=>b.onclick=()=>{
    $$('#tabs button').forEach(x=>x.classList.toggle('active',x===b));
    $$('.tab').forEach(s=>s.classList.toggle('active', s.id===b.dataset.tab));
  });
}

/* ---------- render ---------- */
function renderAll(){ $('#subtitle').textContent='Music finance · '+(STATE.account.code||'')+' · '+STATE.year;
  fillMotionSelect(); renderRegister(); renderMotions(); renderBudget(); renderReconcile(); }

function fillMotionSelect(){
  const sel=$('#f-motion'); const cur=sel.value;
  sel.innerHTML='<option value="">(none)</option>'+STATE.motions.map(m=>`<option value="${esc(m.number)}">${esc(m.number)} — ${esc(m.description)}</option>`).join('');
  sel.value=cur;
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderRegister(){
  const q=norm($('#q').value);
  const tb=$('#regTable tbody'); tb.innerHTML='';
  let rows=STATE.invoices.map((x,i)=>({x,i}));
  rows.sort((a,b)=>(a.x.date||'').localeCompare(b.x.date||''));
  let shown=0, tot=0;
  rows.forEach(({x,i})=>{
    tot+=Number(x.gross||0);
    if(q){ const hay=norm([x.vendor,x.description,x.invoiceNo,x.motion,x.po].join(' ')); if(!hay.includes(q)) return; }
    shown++;
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${esc(x.date||'')}</td>
      <td class="clickable">${esc(x.vendor||'')}</td>
      <td class="clickable">${esc(x.description||'')}</td>
      <td>${esc(x.motion||'')}</td>
      <td class="num">${money(x.gross)}</td>
      <td><span class="tag ${esc(x.docStatus||'')}">${esc(x.docStatus||'')}</span></td>
      <td class="filecell">${x.file?'<button class="openf" title="'+esc(x.file)+'">Open</button>':'<button class="attachf ghost">Attach</button>'}</td>
      <td>${x.paid?'Paid':'<span class="muted">Unpaid</span>'}</td>
      <td><button class="del" title="Delete">&#215;</button></td>`;
    tr.querySelectorAll('.clickable').forEach(c=>c.onclick=()=>loadInvoice(i));
    const of=tr.querySelector('.openf'); if(of) of.onclick=()=>openDoc(x);
    const af=tr.querySelector('.attachf'); if(af) af.onclick=()=>attachDoc(i);
    tr.querySelector('.del').onclick=()=>{ if(confirm('Delete this invoice?')){ STATE.invoices.splice(i,1); markDirty(); renderAll(); } };
    tb.appendChild(tr);
  });
  $('#regcount').textContent=`${shown} of ${STATE.invoices.length} shown · total ${money(tot)}`;
}
function loadInvoice(i){
  const x=STATE.invoices[i]; editId=i;
  $('#f-date').value=x.date||''; $('#f-vendor').value=x.vendor||''; $('#f-desc').value=x.description||'';
  $('#f-po').value=x.po||''; $('#f-inv').value=x.invoiceNo||''; $('#f-motion').value=x.motion||'';
  $('#f-gross').value=x.gross!=null?x.gross:''; $('#f-gst').value=x.gst!=null?x.gst:'';
  $('#f-doc').value=x.docStatus||'Documented'; $('#f-paid').value=String(!!x.paid); $('#f-notes').value=x.notes||'';
  $('#btnAdd').textContent='Update invoice'; $('#editing').textContent='editing row '+(i+1);
  $('#f-vendor').focus(); window.scrollTo({top:0,behavior:'smooth'});
}
function clearForm(){ editId=null; $('#invForm').reset(); $('#btnAdd').textContent='Add invoice'; $('#editing').textContent=''; }

function renderMotions(){
  $('#motionYear').textContent='('+STATE.year+')';
  const spent={}, cnt={};
  STATE.invoices.forEach(x=>{ if(x.motion){ spent[x.motion]=(spent[x.motion]||0)+Number(x.gross||0); cnt[x.motion]=(cnt[x.motion]||0)+1; }});
  const tb=$('#motTable tbody'); tb.innerHTML='';
  STATE.motions.forEach((m,idx)=>{
    const s=spent[m.number]||0, a=Number(m.allocation||0), rem=a-s, pct=a>0?Math.min(100,Math.round(s/a*100)):0, over=s>a;
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${esc(m.number)}</td><td>${esc(m.description)}</td>
      <td class="num">${money(a)}</td><td class="num">${money(s)}</td>
      <td class="num" style="${over?'color:var(--oxblood-soft);font-weight:600':''}">${money(rem)}</td>
      <td class="bar"><div class="barwrap"><div class="barfill ${over?'over':''}" style="width:${over?100:pct}%"></div></div><span class="muted">${a>0?pct+'%':'-'}</span></td>
      <td class="num">${cnt[m.number]||0}</td>
      <td><button class="del">&#215;</button></td>`;
    tr.querySelector('.del').onclick=()=>{ if(confirm('Remove motion '+m.number+'?')){ STATE.motions.splice(idx,1); markDirty(); renderAll(); } };
    tb.appendChild(tr);
  });
  // unallocated
  const un=STATE.invoices.filter(x=>!x.motion).reduce((t,x)=>t+Number(x.gross||0),0);
  if(un>0){ const tr=document.createElement('tr'); tr.style.opacity=.75;
    tr.innerHTML=`<td>-</td><td>Invoices with no motion</td><td class="num">-</td><td class="num">${money(un)}</td><td class="num">-</td><td class="bar"></td><td class="num">${STATE.invoices.filter(x=>!x.motion).length}</td><td></td>`;
    tb.appendChild(tr); }
}

function renderBudget(){
  const alloc=STATE.account.allocations.reduce((t,a)=>t+Number(a.amount||0),0);
  const nettOf=l=> l.nett!=null? Number(l.nett): Number(l.gross||0);
  const spentLedger=STATE.ledger.reduce((t,l)=>t+nettOf(l),0);
  const exOf=x=>Number(x.gross||0)-Number(x.gst||0);
  const spentReg=STATE.invoices.reduce((t,x)=>t+exOf(x),0);
  const totalSpent = STATE.ledger.length? spentLedger : spentReg;        // all outgoings ex GST
  const msgSpent = STATE.invoices.reduce((t,x)=> t + (x.motion? exOf(x):0), 0); // MSG-funded, reimbursed
  const ownSpent = totalSpent - msgSpent;                                // your own D5720 burn
  const ownRem = alloc - ownSpent;
  const miss=STATE.invoices.filter(x=>x.docStatus==='Missing').length;
  $('#budgetCards').innerHTML=[
    card('Allocated (ex GST)',money(alloc)),
    card('Total outgoings (ex GST)',money(totalSpent)),
    card('MSG-funded (reimbursable)',money(msgSpent)),
    card('Your D5720 spend',money(ownSpent)),
    card('On track: remaining',money(ownRem),ownRem<0?'over':'good'),
    card('Missing docs',miss,miss>0?'over':'good')
  ].join('');
  $('#budgetNote').textContent='Your D5720 spend strips out the MSG-funded items (they net to zero once the Music Support Group reimburses). "On track: remaining" is your allocation minus your own spend. "Total outgoings" is everything that left the account, MSG layer included.';
  const tb=$('#allocTable tbody'); tb.innerHTML='';
  STATE.account.allocations.forEach((a,idx)=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${esc(a.desc)}</td><td>${esc(a.date||'')}</td><td class="num">${money(a.amount)}</td><td><button class="del">&#215;</button></td>`;
    tr.querySelector('.del').onclick=()=>{ STATE.account.allocations.splice(idx,1); markDirty(); renderAll(); };
    tb.appendChild(tr);
  });
}
function card(k,v,cls){ return `<div class="card ${cls||''}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`; }

function matchIndexLedger(){
  // returns Set of ledger indices matched, and Set of invoice indices matched
  const regKeys=STATE.invoices.map(x=>[norm(x.invoiceNo),norm(x.po)].filter(k=>k.length>=4));
  const ledMatched=new Set(), regMatched=new Set();
  STATE.ledger.forEach((l,li)=>{
    const lk=[norm(l.invoiceNo),norm(l.order)].filter(k=>k.length>=4);
    for(let ri=0; ri<regKeys.length; ri++){
      if(regKeys[ri].some(k=>lk.includes(k))){ ledMatched.add(li); regMatched.add(ri); }
    }
  });
  return {ledMatched,regMatched};
}
function renderReconcile(){
  $('#ledMeta').textContent = STATE.ledger.length? `${STATE.ledger.length} ledger lines · ${esc(STATE.ledgerMeta.source||'')}` : 'No ledger imported yet.';
  const {ledMatched,regMatched}=matchIndexLedger();
  const spend=STATE.ledger.filter(l=>l.type!=='CHG');
  const matchedSpend=spend.filter((l,i)=>ledMatched.has(STATE.ledger.indexOf(l)));
  $('#recCards').innerHTML=[
    card('Ledger spend lines',spend.length),
    card('Matched to a logged invoice',ledMatched.size,'good'),
    card('Ledger lines not logged',STATE.ledger.filter((l,i)=>!ledMatched.has(i)&&l.type!=='CHG').length,'over'),
    card('Logged invoices not on ledger',STATE.invoices.filter((x,i)=>!regMatched.has(i)).length)
  ].join('');
  const t1=$('#recLedger tbody'); t1.innerHTML='';
  STATE.ledger.forEach((l,i)=>{ if(ledMatched.has(i)||l.type==='CHG') return;
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${esc(l.date)}</td><td>${esc(l.vendor)}</td><td>${esc(l.description)}</td><td>${esc(l.invoiceNo)}</td><td class="num">${money(l.gross)}</td>`;
    t1.appendChild(tr); });
  if(!t1.children.length) t1.innerHTML='<tr><td colspan="5" class="muted">Everything on the ledger is logged.</td></tr>';
  const t2=$('#recReg tbody'); t2.innerHTML='';
  STATE.invoices.forEach((x,i)=>{ if(regMatched.has(i)) return;
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${esc(x.date)}</td><td>${esc(x.vendor)}</td><td>${esc(x.invoiceNo)}</td><td class="num">${money(x.gross)}</td><td>${x.paid?'Paid':'Unpaid'}</td>`;
    t2.appendChild(tr); });
  if(!t2.children.length) t2.innerHTML='<tr><td colspan="5" class="muted">Every logged invoice appears on the ledger.</td></tr>';
}

/* ---------- forms ---------- */
function wireForms(){
  $('#q').oninput=renderRegister;
  $('#btnClear').onclick=clearForm;
  $('#invForm').onsubmit=e=>{
    e.preventDefault();
    const rec={date:$('#f-date').value, vendor:$('#f-vendor').value.trim(), description:$('#f-desc').value.trim(),
      po:$('#f-po').value.trim(), invoiceNo:$('#f-inv').value.trim(), motion:$('#f-motion').value,
      gross:parseFloat($('#f-gross').value||0), gst:$('#f-gst').value?parseFloat($('#f-gst').value):null,
      docStatus:$('#f-doc').value, paid:$('#f-paid').value==='true', notes:$('#f-notes').value.trim()};
    if(editId!=null){ STATE.invoices[editId]=rec; } else { STATE.invoices.push(rec); }
    markDirty(); clearForm(); renderAll(); toast(editId!=null?'Invoice updated':'Invoice added');
  };
  $('#motForm').onsubmit=e=>{
    e.preventDefault();
    const num=$('#m-num').value.trim(); if(!num) return;
    const desc=$('#m-desc').value.trim(); const alloc=parseFloat($('#m-alloc').value||0);
    const ex=STATE.motions.find(m=>m.number===num);
    if(ex){ ex.description=desc||ex.description; ex.allocation=alloc||ex.allocation; }
    else STATE.motions.push({number:num,description:desc,allocation:alloc});
    markDirty(); e.target.reset(); renderAll(); toast('Motion saved');
  };
  $('#allocForm').onsubmit=e=>{
    e.preventDefault();
    const d=$('#a-desc').value.trim(); const amt=parseFloat($('#a-amt').value||0);
    if(!d||!amt) return;
    STATE.account.allocations.push({desc:d,date:$('#a-date').value,amount:amt});
    markDirty(); e.target.reset(); renderAll(); toast('Allocation added');
  };
}

/* ---------- data tab ---------- */
function wireData(){
  $('#btnSave').onclick=()=>saveToFile();
  $('#btnSave2').onclick=()=>saveToFile();
  $('#btnWorkspace').onclick=chooseWorkspace;
  $('#btnOpen').onclick=openFile;
  $('#rmFile').onchange=importRM;
  $('#btnExport').onclick=exportXlsx;
  $('#btnReseed').onclick=async()=>{ if(!confirm('Reload the 2026 sample data? This replaces current entries.')) return;
    try{ STATE=await (await fetch('seed.json',{cache:'no-store'})).json(); markDirty(); renderAll(); toast('2026 sample loaded'); }catch(e){ toast('Could not load sample'); } };
  $('#btnNewYear').onclick=()=>{
    const y=prompt('Start a new year. Keeps your motion list as a template, clears invoices and ledger.\n\nNew year:', String(STATE.year+1));
    if(!y) return;
    STATE.year=parseInt(y,10)||STATE.year;
    STATE.invoices=[]; STATE.ledger=[]; STATE.ledgerMeta={};
    STATE.account.allocations=[];
    markDirty(); renderAll(); toast('New year '+STATE.year+' started');
  };
  $('#dataNote').textContent = hasDir
    ? 'Built for Chrome or Edge on your PC. Choose your Finance folder once; Save then writes tally-data.json into it and invoice files open straight from it.'
    : 'This browser does not support folder access. Use a Chromium browser (Chrome/Edge) on the PC for invoice storage; otherwise Save/Open work on a single data file only.';
}

function importRM(e){
  const f=e.target.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=()=>{
    try{
      const wb=XLSX.read(r.result,{type:'array'});
      let ws=wb.Sheets['Cash Transactions']||wb.Sheets[wb.SheetNames.find(n=>/cash/i.test(n))]||wb.Sheets[wb.SheetNames[0]];
      const aoa=XLSX.utils.sheet_to_json(ws,{header:1,raw:false});
      let hi=aoa.findIndex(row=>row && row.some(c=>/invoice/i.test(c||'')) && row.some(c=>/gross/i.test(c||'')));
      if(hi<0) hi=0;
      const H=aoa[hi].map(c=>String(c||'').toLowerCase());
      const col=names=>H.findIndex(h=>names.some(n=>h.includes(n)));
      const ci={vendor:col(['account']),desc:col(['description']),order:col(['order']),inv:col(['invoice']),
        type:col(['type']),date:col(['date']),gross:col(['gross']),nett:col(['nett','net']),gst:col(['tax'])};
      const numAt=(row,c)=>{ if(c<0) return null; const v=parseFloat(String(row[c]||'').replace(/[^0-9.\-]/g,'')); return isNaN(v)?null:v; };
      const MON={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
      const iso=s=>{ const m=/(\d{1,2})\s+(\w{3})\w*\s+(\d{4})/.exec(String(s||'')); return m?`${m[3]}-${String(MON[m[2].toLowerCase()]).padStart(2,'0')}-${m[1].padStart(2,'0')}`:String(s||''); };
      const out=[];
      for(let i=hi+1;i<aoa.length;i++){ const row=aoa[i]; if(!row||!row.length) continue;
        const desc=row[ci.desc]; const gross=parseFloat(String(row[ci.gross]||'').replace(/[^0-9.\-]/g,''));
        if((desc==null||desc==='') && !gross) continue;
        if(/^totals/i.test(String(desc||''))) continue;
        out.push({date:iso(row[ci.date]),vendor:String(row[ci.vendor]||'').trim(),description:String(desc||'').trim(),
          order:String(row[ci.order]||'').trim(),invoiceNo:String(row[ci.inv]||'').trim(),
          type:String(row[ci.type]||'').trim(),gross:isNaN(gross)?0:gross,
          nett:numAt(row,ci.nett),gst:numAt(row,ci.gst)});
      }
      if(!out.length){ toast('No rows found in that file'); return; }
      STATE.ledger=out; STATE.ledgerMeta={source:f.name,importedAt:new Date().toISOString().slice(0,10)};
      markDirty(); renderAll(); toast('Imported '+out.length+' ledger lines');
    }catch(err){ console.warn(err); toast('Could not read that file'); }
    finally{ e.target.value=''; }
  };
  r.readAsArrayBuffer(f);
}

function exportXlsx(){
  const wb=XLSX.utils.book_new();
  // Budget summary (net of MSG)
  const alloc=STATE.account.allocations.reduce((t,a)=>t+Number(a.amount||0),0);
  const exOf=x=>Number(x.gross||0)-Number(x.gst||0);
  const nettOf=l=> l.nett!=null? Number(l.nett): Number(l.gross||0);
  const totalSpent=STATE.ledger.length? STATE.ledger.reduce((t,l)=>t+nettOf(l),0) : STATE.invoices.reduce((t,x)=>t+exOf(x),0);
  const msgSpent=STATE.invoices.reduce((t,x)=>t+(x.motion?exOf(x):0),0);
  const bud=[['D5720 Budget ('+STATE.year+')','ex GST'],
    ['Allocated',alloc],['Total outgoings (incl MSG layer)',totalSpent],
    ['Less: MSG-funded (reimbursable)',-msgSpent],['Your D5720 spend',totalSpent-msgSpent],
    ['On track: remaining',alloc-(totalSpent-msgSpent)]];
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(bud),'Budget');
  // Register
  const reg=[['Date','Vendor','Description','PO/Order','Invoice','MSG Motion','Gross','GST','Status','Paid','Notes']];
  STATE.invoices.slice().sort((a,b)=>(a.date||'').localeCompare(b.date||'')).forEach(x=>
    reg.push([x.date,x.vendor,x.description,x.po,x.invoiceNo,x.motion,x.gross,x.gst,x.docStatus,x.paid?'Paid':'Unpaid',x.notes]));
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(reg),'Register');
  // Motion tally
  const spent={}; STATE.invoices.forEach(x=>{ if(x.motion) spent[x.motion]=(spent[x.motion]||0)+Number(x.gross||0); });
  const mt=[['MSG Motion','Purpose','Allocation','Spent','Remaining']];
  STATE.motions.forEach(m=>mt.push([m.number,m.description,m.allocation,spent[m.number]||0,Number(m.allocation||0)-(spent[m.number]||0)]));
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(mt),'Motion Tally');
  XLSX.writeFile(wb,'Tally reconciliation '+STATE.year+'.xlsx');
  toast('Workbook exported');
}

window.addEventListener('beforeunload', e=>{ if(dirty){ e.preventDefault(); e.returnValue=''; } });
