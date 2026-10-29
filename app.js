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
let regFilter = 'all';
let formFile = null;      // File waiting to be attached from the form
let formMeta = {};        // ABNs read from the invoice
let autoIds = new Set();  // fields filled by the reader
let formUnlink = false;   // user unlinked the file in the edit form
const DIRTY_KEY = 'tally-dirty';
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
  try{ dirty = localStorage.getItem(DIRTY_KEY)==='1'; }catch(e){ dirty=false; }
  renderAll(); updateSaveState(); await checkFolderAccess(false);
  if('serviceWorker' in navigator){ try{ navigator.serviceWorker.register('sw.js'); }catch(e){} }
}
function blankState(){ return {schema:1,appName:'Tally',year:new Date().getFullYear(),
  account:{code:'D5720',name:'Music',allocations:[]}, motions:[], invoices:[], ledger:[], ledgerMeta:{}}; }

/* ---------- persistence ---------- */
function cache(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(STATE)); }catch(e){} }
function setDirty(v){ dirty=v; try{ localStorage.setItem(DIRTY_KEY, v?'1':'0'); }catch(e){} }
let autoTimer=null, lastSaved=null;
function autosaveOn(){ try{ return localStorage.getItem('tally-autosave')!=='0'; }catch(e){ return true; } }
function markDirty(){ setDirty(true); cache(); updateSaveState();
  if(autosaveOn() && dirHandle){ clearTimeout(autoTimer); autoTimer=setTimeout(autoSave,1200); } }
/* silent save to the Finance folder; only when access is already granted (never pops a prompt) */
async function autoSave(){
  if(!dirty || !dirHandle || !(await folderGranted())) { updateSaveState(); return; }
  try{ await writeFolderJSON('tally-data.json', STATE); setDirty(false); lastSaved=new Date(); updateSaveState(); }
  catch(e){ console.warn(e); }
}
async function writeFolderJSON(name, data){
  const fh=await dirHandle.getFileHandle(name,{create:true});
  const w=await fh.createWritable(); await w.write(JSON.stringify(data,null,1)); await w.close();
}
function updateSaveState(){
  const p=$('#saveState'); const linked = !!(dirHandle||fileHandle);
  if(dirty){ p.textContent='unsaved'; p.className='pill unsaved'; }
  else { p.textContent = linked? (lastSaved? 'saved '+lastSaved.toLocaleTimeString('en-AU',{hour:'numeric',minute:'2-digit'}) : 'saved') : 'cache only'; p.className='pill '+(linked?'saved':''); }
  const ws=$('#wsStatus');
  if(ws) ws.textContent = dirHandle? ('Workspace: '+dirHandle.name+' / '+invFolder()+' (invoice files)') : 'No workspace folder chosen yet. Click "Choose Finance folder".';
}
async function ensurePerm(handle,write){
  if(!handle||!handle.queryPermission) return true;
  const opt={mode:write?'readwrite':'read'};
  if(await handle.queryPermission(opt)==='granted') return true;
  return (await handle.requestPermission(opt))==='granted';
}
async function folderGranted(){
  if(!dirHandle||!dirHandle.queryPermission) return !!dirHandle;
  try{ return (await dirHandle.queryPermission({mode:'readwrite'}))==='granted'; }catch(e){ return false; }
}
/* Shows the reconnect button / banner. With ask=true (needs a click) it requests access,
   then loads tally-data.json from the folder unless there are unsaved changes here. */
async function checkFolderAccess(ask, reload){
  if(reload===undefined) reload=ask;
  let ok=await folderGranted();
  if(!ok && ask && dirHandle){ try{ ok=(await dirHandle.requestPermission({mode:'readwrite'}))==='granted'; }catch(e){} }
  if(ok && reload && !dirty){
    try{ const fh=await dirHandle.getFileHandle('tally-data.json'); STATE=JSON.parse(await (await fh.getFile()).text()); cache(); renderAll(); }catch(e){}
  }
  $('#btnReconnect').hidden = !(dirHandle && !ok);
  const b=$('#folderBanner');
  if(!dirHandle){ b.classList.add('show'); $('#folderBannerText').textContent="Your Finance folder isn't connected yet, so invoice files can't be opened or attached."; $('#btnBannerConnect').textContent='Choose Finance folder'; }
  else if(!ok){ b.classList.add('show'); $('#folderBannerText').textContent='Chrome needs you to re-allow access to "'+dirHandle.name+'" for this session before invoices can open or attach.'; $('#btnBannerConnect').textContent='Reconnect folder'; }
  else b.classList.remove('show');
  if(ok && ask) toast('Connected to '+dirHandle.name);
  if(ok && dirty && autosaveOn()) autoSave();
  updateSaveState();
  return ok;
}
async function needFolder(){
  if(!dirHandle){ toast('Choose your Finance folder first'); return false; }
  if(await folderGranted()) return true;
  return await checkFolderAccess(true,false);
}
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1900); }

async function saveToFile(){
  const json = JSON.stringify(STATE,null,1);
  // prefer the workspace folder
  if(dirHandle){
    try{
      if(await ensurePerm(dirHandle,true)){
        await writeFolderJSON('tally-data.json', STATE); lastSaved=new Date();
        setDirty(false); updateSaveState(); toast('Saved to '+dirHandle.name); return;
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
      setDirty(false); updateSaveState(); toast('Saved to file'); return;
    }catch(e){ if(e&&e.name==='AbortError') return; console.warn(e); }
  }
  const blob=new Blob([json],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='tally-data.json';
  a.click(); URL.revokeObjectURL(a.href);
  setDirty(false); updateSaveState(); toast('Data file downloaded');
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
      STATE=existing; setDirty(false);
    } else {
      setDirty(true); // need to write current state into the folder
    }
    renderAll(); updateSaveState(); checkFolderAccess(false);
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
let pvUrl=null, pvIndex=null;
async function openDoc(x, i){
  if(!x.file){ toast('No file linked yet'); return; }
  if(!await needFolder()) return;
  try{
    const f=await resolveFile(x.file);
    if(pvUrl) URL.revokeObjectURL(pvUrl);
    pvUrl=URL.createObjectURL(f); pvIndex=(i==null?null:i);
    $('#pvName').textContent=x.file.split('/').pop();
    const isImg=/^image\//.test(f.type)||/\.(png|jpe?g|webp)$/i.test(f.name);
    $('#pvBody').innerHTML= isImg? '<img class="prev" alt="Invoice">' : '<iframe title="Invoice preview"></iframe>';
    $('#pvBody').firstChild.src=pvUrl;
    $('#pvReplace').hidden = pvIndex==null;
    $('#previewModal').classList.add('show');
  }catch(e){ console.warn(e); toast('Could not find '+x.file.split('/').pop()+' in the folder'); }
}
function closePreview(){ $('#previewModal').classList.remove('show'); $('#pvBody').innerHTML=''; if(pvUrl){ URL.revokeObjectURL(pvUrl); pvUrl=null; } }
function sanitize(s){ return String(s||'').replace(/[\\/:*?"<>|]/g,'-').replace(/\s+/g,' ').trim(); }
function amt(n){ const v=Math.abs(Number(n||0)); return '$'+(Number.isInteger(v)? String(v) : v.toFixed(2)); }
/* Name in Dijon's convention: Invoice - 2026-05-05 - Harry Oliff - Arts Day Sound Tech ($500) (INV-4034, PO538668).pdf */
function docName(x, ext){
  const kind = x.card? 'Receipt' : 'Invoice';
  let vendor=x.vendor||'', desc=x.description||'';
  if(/purchasing cards/i.test(vendor) && desc.includes(':')){ vendor=desc.split(':')[0]; desc=desc.split(':').slice(1).join(':'); }
  const refs=[x.invoiceNo, x.po? 'PO'+String(x.po).replace(/^po/i,''):''].filter(Boolean).join(', ');
  const parts=[kind, x.date||'', sanitize(vendor).slice(0,40), sanitize(desc).slice(0,50)+(x.gross? ' ('+amt(x.gross)+')':'')].filter(Boolean);
  return sanitize(parts.join(' - ')+(refs? ' ('+refs+')':'')).slice(0,180)+ext;
}
async function writeAttachment(i, src){
  if(!await needFolder()) return false;
  try{
    const ext=((src.name||'').match(/\.[a-z0-9]+$/i)||['.pdf'])[0].toLowerCase();
    if(!/\.(pdf|png|jpe?g|webp|heic)$/.test(ext)){ toast('Attach a PDF or image'); return false; }
    const x=STATE.invoices[i];
    let name=docName(x,ext);
    const sub=await dirHandle.getDirectoryHandle(invFolder(),{create:true});
    // avoid overwriting a different existing file
    for(let n=2;n<20;n++){ try{ await sub.getFileHandle(name); if(x.file===invFolder()+'/'+name) break; name=docName(x,' ('+n+')'+ext); }catch(e){ break; } }
    const fh=await sub.getFileHandle(name,{create:true});
    const w=await fh.createWritable(); await w.write(await src.arrayBuffer()); await w.close();
    x.file=invFolder()+'/'+name;
    if(x.docStatus==='Missing') x.docStatus='Documented';
    markDirty(); renderAll(); toast('Attached '+name);
    return true;
  }catch(e){ console.warn(e); toast('Could not attach file'); return false; }
}
async function pickFile(){
  if(window.showOpenFilePicker){
    try{ const [h]=await window.showOpenFilePicker({types:[{description:'Invoice',accept:{'application/pdf':['.pdf'],'image/*':['.png','.jpg','.jpeg','.webp']}}]}); return await h.getFile(); }
    catch(e){ return null; }
  }
  return await new Promise(res=>{ const inp=document.createElement('input'); inp.type='file'; inp.accept='.pdf,image/*';
    inp.onchange=()=>res(inp.files[0]||null); inp.click(); });
}
async function attachDoc(i){
  if(!await needFolder()) return;
  const f=await pickFile(); if(f) await writeAttachment(i,f);
}
/* ---------- find matching files already sitting in the Finance folder ---------- */
let scanMatches=[];
async function walk(dir, prefix, out, depth){
  if(depth>5 || out.length>5000) return;
  for await (const [name,h] of dir.entries()){
    if(name.startsWith('.')) continue;
    if(h.kind==='directory') await walk(h, prefix+name+'/', out, depth+1);
    else if(/\.(pdf|png|jpe?g|webp)$/i.test(name)) out.push(prefix+name);
  }
}
function needsFile(x, uses){ return !x.file || isCombined(x, uses); }
/* A file counts as "combined" if it is a multi-invoice scan, or is shared by rows with different invoice numbers
   (rows with the same invoice no. sharing one receipt, e.g. fee + booking fee, are fine). */
function isCombined(x, uses){ return !!x.file && ((uses[x.file]||new Set()).size>1 || /combined|all invoices|^report/i.test(x.file.split('/').pop())); }
function fileUses(){ const u={}; STATE.invoices.forEach(x=>{ if(x.file){ (u[x.file]=u[x.file]||new Set()).add(norm(x.invoiceNo)||'?'); } }); return u; }
async function scanFolder(){
  if(!await needFolder()) return;
  toast('Scanning '+dirHandle.name+'…');
  const files=[]; try{ await walk(dirHandle,'',files,0); }catch(e){ console.warn(e); toast('Could not read the folder'); return; }
  const linked=new Set(STATE.invoices.map(x=>x.file).filter(Boolean));
  const free=files.filter(f=>!linked.has(f));
  const uses=fileUses(); const taken=new Set();
  scanMatches=[];
  STATE.invoices.forEach((x,i)=>{
    if(!needsFile(x,uses)) return;
    let best=null;
    free.forEach(f=>{
      if(taken.has(f)) return;
      const n=norm(f.split('/').pop());
      let score=0, why=[];
      const inv=norm(x.invoiceNo), po=norm(x.po);
      if(inv.length>=4 && n.includes(inv)){ score+=3; why.push('invoice no.'); }
      if(po.length>=5 && n.includes(po)){ score+=3; why.push('PO'); }
      const a=norm(amt(x.gross)); if(x.gross && n.includes(a) && a.length>=3){ score+=1; why.push('amount'); }
      let vend=(/purchasing cards/i.test(x.vendor||'') && (x.description||'').includes(':'))? x.description.split(':')[0] : (x.vendor||'');
      const tok=vend.toLowerCase().split(/[^a-z0-9]+/).filter(t=>t.length>=4 && !/^(the|music|online|perth|australia|pty|ltd)$/.test(t));
      if(tok.some(t=>n.includes(t))){ score+=1; why.push('vendor'); }
      if(x.date && n.includes(norm(x.date))){ score+=1; why.push('date'); }
      if(score>=2 && (!best || score>best.score)) best={f,score,why};
    });
    if(best){ taken.add(best.f); scanMatches.push({i,file:best.f,score:best.score,why:best.why}); }
  });
  renderScan(free.length);
}
function renderScan(freeCount){
  const tb=$('#scanBody'); tb.innerHTML='';
  $('#scanTitle').textContent= scanMatches.length? `${scanMatches.length} suggested match${scanMatches.length>1?'es':''} (${freeCount} unlinked files in the folder)` : `No matches found (${freeCount} unlinked files in the folder)`;
  $('#scanLinkStrong').hidden = !scanMatches.some(m=>m.score>=3);
  scanMatches.forEach((m,k)=>{
    const x=STATE.invoices[m.i]; const tr=document.createElement('tr');
    tr.innerHTML=`<td><div class="vend">${esc(x.vendor)}</div><div class="descr">${esc(x.date)} · ${esc(x.description)} · ${money(x.gross)}</div></td>
      <td class="fname">${esc(m.file)}</td>
      <td><span class="strength ${m.score>=3?'strong':'likely'}">${m.score>=3?'Strong':'Likely'}</span><div class="muted">${esc(m.why.join(', '))}</div></td>
      <td style="white-space:nowrap"><button class="small" data-a="pv">Preview</button> <button class="small brass" data-a="link">Link</button></td>`;
    tr.querySelector('[data-a=pv]').onclick=()=>openDoc({file:m.file});
    tr.querySelector('[data-a=link]').onclick=()=>{ linkMatch(m); tr.remove(); };
    tb.appendChild(tr);
  });
  $('#scanModal').classList.add('show');
}
function linkMatch(m){ const x=STATE.invoices[m.i]; x.file=m.file; if(x.docStatus==='Missing') x.docStatus='Documented'; m.done=true; markDirty(); renderAll(); }
async function openFile(){
  if(hasFS){
    try{
      const [h]=await window.showOpenFilePicker({types:[{description:'Tally data',accept:{'application/json':['.json']}}]});
      fileHandle=h; await idb.set('fileHandle',h);
      const f=await h.getFile(); STATE=JSON.parse(await f.text());
      setDirty(false); renderAll(); updateSaveState(); toast('Loaded '+f.name); return;
    }catch(e){ if(e&&e.name==='AbortError') return; console.warn(e); }
  }
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.json';
  inp.onchange=async()=>{ const f=inp.files[0]; if(!f) return; STATE=JSON.parse(await f.text());
    setDirty(false); renderAll(); updateSaveState(); toast('Loaded '+f.name); };
  inp.click();
}

/* ---------- tabs ---------- */
function wireTabs(){
  const R={register:renderRegister,motions:renderMotions,budget:renderBudget,reconcile:renderReconcile};
  $$('#tabs button').forEach(b=>b.onclick=()=>{
    $$('#tabs button').forEach(x=>x.classList.toggle('active',x===b));
    $$('.tab').forEach(s=>s.classList.toggle('active', s.id===b.dataset.tab));
    if(R[b.dataset.tab]) R[b.dataset.tab]();   // recompute the tab being shown
  });
}

/* ---------- render ---------- */
function renderAll(){ $('#subtitle').textContent='Music finance · '+(STATE.account.code||'')+' · '+STATE.year;
  fillMotionSelect(); fillVendors(); renderRegister(); renderMotions(); renderBudget(); renderReconcile(); }

function fillMotionSelect(){
  const sel=$('#f-motion'); const cur=sel.value;
  sel.innerHTML='<option value="">(none)</option>'+STATE.motions.map(m=>`<option value="${esc(m.number)}">${esc(m.number)} — ${esc(m.description)}</option>`).join('');
  sel.value=cur;
}
function fillVendors(){ const v=[...new Set(STATE.invoices.map(x=>x.vendor).filter(Boolean))].sort(); $('#vendorList').innerHTML=v.map(n=>'<option value="'+esc(n)+'">').join(''); }
function stageOf(x){ return x.committed? 'committed' : (x.paid? 'paid' : 'unpaid'); }
function stageTag(x){ const st=stageOf(x); return st==='paid'?'Paid': st==='committed'?'<span class="tag Committed" title="PO raised, not invoiced yet">Committed</span>':'<span class="tag Unpaid">Unpaid</span>'; }
const exOf=x=>Number(x.gross||0)-Number(x.gst||0);
function daysSince(d){ if(!d) return null; const t=Date.parse(d); if(isNaN(t)) return null; return Math.max(0,Math.floor((Date.now()-t)/86400000)); }
function today(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function motionSpend(){ const sp={}; STATE.invoices.forEach(x=>{ if(x.motion) sp[x.motion]=(sp[x.motion]||0)+Number(x.gross||0); }); return sp; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function regCounts(uses){
  return {all:STATE.invoices.length,
    need:STATE.invoices.filter(x=>needsFile(x,uses)).length,
    check:STATE.invoices.filter(x=>x.docStatus==='Check').length,
    msg:STATE.invoices.filter(x=>x.motion && !x.msgPaid).length};
}
function renderRegister(){
  const q=norm($('#q').value);
  const tb=$('#regTable tbody'); tb.innerHTML='';
  const uses=fileUses(); const c=regCounts(uses);
  ['all','need','check','msg'].forEach(k=>$('#n-'+k).textContent=c[k]);
  const nb=$('#needBadge'); nb.hidden=!c.need; nb.textContent=c.need; nb.title=c.need+' invoices need their own file attached';
  let rows=STATE.invoices.map((x,i)=>({x,i}));
  rows.sort((a,b)=>(b.x.date||'').localeCompare(a.x.date||''));   // newest first
  let shown=0, tot=0;
  rows.forEach(({x,i})=>{
    if(regFilter==='need' && !needsFile(x,uses)) return;
    if(regFilter==='check' && x.docStatus!=='Check') return;
    if(regFilter==='msg' && !(x.motion && !x.msgPaid)) return;
    if(q){ const hay=norm([x.vendor,x.description,x.invoiceNo,x.motion,x.po,x.card,x.notes].join(' ')); if(!hay.includes(q)) return; }
    shown++; tot+=Number(x.gross||0);
    const comb=isCombined(x,uses);
    const doc = !x.file ? '<button class="doc none attachf" title="Attach the invoice PDF (or drag it onto this row)">Attach</button>'
      : comb ? '<button class="doc shared openf" title="Linked to a combined scan or a file shared with another row. Attach the individual invoice if you have it.">Combined ▸</button> <button class="small attachf" title="Attach the individual invoice">Attach own</button>'
      : '<button class="doc ok openf" title="'+esc(x.file)+'">Invoice ▸</button>';
    const refs=[x.po?'<b>PO</b> '+esc(x.po):'', x.invoiceNo?'<b>Inv</b> '+esc(x.invoiceNo):'', x.card?'<b>Card</b> '+esc(x.card):''].filter(Boolean).join('<br>');
    const tr=document.createElement('tr');
    tr.innerHTML=`<td class="date">${esc(x.date||'')}</td>
      <td class="clickable" title="Click to edit"><div class="vend">${esc(x.vendor||'')}</div><div class="descr">${esc(x.description||'')}</div>${x.motion?'<div class="motionref">MSG '+esc(x.motion)+'</div>':''}</td>
      <td class="refs">${refs||'<span class="muted">-</span>'}</td>
      <td class="num">${money(x.gross)}</td>
      <td class="invcell">${doc}${x.docStatus==='Check'?'<span class="tag Check">Check</span>':''}</td>
      <td>${stageTag(x)}</td>
      <td class="msgcell">${x.motion?
        '<label title="MSG reimbursement invoice sent to accounts"><input type="checkbox" class="cbsent" '+(x.msgSent?'checked':'')+'>Sent</label>'+
        '<label title="MSG reimbursement confirmed paid by accounts"><input type="checkbox" class="cbpaid" '+(x.msgPaid?'checked':'')+'>Reimbursed</label>'
        :'<span class="muted">-</span>'}</td>
      <td><button class="del" title="Delete row (the invoice file stays in your folder)">&#215;</button></td>`;
    tr.querySelector('.clickable').onclick=()=>loadInvoice(i);
    const of=tr.querySelector('.openf'); if(of) of.onclick=()=>openDoc(x,i);
    const af=tr.querySelector('.attachf'); if(af) af.onclick=()=>attachDoc(i);
    const cs=tr.querySelector('.cbsent'); if(cs) cs.onchange=()=>{ setSent(STATE.invoices[i],cs.checked); markDirty(); renderAll(); };
    const cp=tr.querySelector('.cbpaid'); if(cp) cp.onchange=()=>{ setReimb(STATE.invoices[i],cp.checked); markDirty(); renderAll(); };
    tr.querySelector('.del').onclick=()=>{ if(confirm('Delete this invoice row?\n\n'+x.vendor+' · '+money(x.gross))){ STATE.invoices.splice(i,1); markDirty(); renderAll(); } };
    // drag a file onto the row to attach it
    tr.addEventListener('dragover',e=>{ if(e.dataTransfer && [...e.dataTransfer.types].includes('Files')){ e.preventDefault(); tr.classList.add('dropover'); } });
    tr.addEventListener('dragleave',()=>tr.classList.remove('dropover'));
    tr.addEventListener('drop',e=>{ e.preventDefault(); e.stopPropagation(); tr.classList.remove('dropover'); const f=e.dataTransfer.files[0]; if(f) writeAttachment(i,f); });
    tb.appendChild(tr);
  });
  if(!shown) tb.innerHTML='<tr><td colspan="8" class="muted" style="padding:18px">'+(regFilter==='need'?'Every invoice has its own file attached.':'Nothing matches.')+'</td></tr>';
  $('#regcount').textContent=`${shown} of ${STATE.invoices.length} shown · ${money(tot)}`;
}
function setSent(x,v){ x.msgSent=v; if(v && !x.msgSentDate) x.msgSentDate=today(); if(!v){ delete x.msgSentDate; x.msgPaid=false; } }
function setReimb(x,v){ x.msgPaid=v; if(v){ if(!x.msgSent) setSent(x,true); x.msgPaidDate=today(); } else delete x.msgPaidDate; }
function loadInvoice(i){
  const x=STATE.invoices[i]; editId=i;
  $('#f-date').value=x.date||''; $('#f-vendor').value=x.vendor||''; $('#f-desc').value=x.description||'';
  $('#f-po').value=x.po||''; $('#f-inv').value=x.invoiceNo||''; $('#f-card').value=x.card||''; $('#f-motion').value=x.motion||'';
  $('#f-gross').value=x.gross!=null?x.gross:''; $('#f-gst').value=x.gst!=null?x.gst:'';
  $('#f-doc').value=x.docStatus||'Documented'; $('#f-paid').value=stageOf(x); $('#f-notes').value=x.notes||'';
  $('#f-sent').checked=!!x.msgSent; $('#f-reimb').checked=!!x.msgPaid;
  $('#btnAdd').textContent='Update invoice'; $('#editing').textContent='Editing '+(x.vendor||'invoice');
  $('#entrySummary').textContent='Edit invoice';
  formFile=null; formUnlink=false; formMeta={}; clearAuto(); $('#readStatus').innerHTML=''; showFormFile(); motionWarn();
  $('#entry').open=true; window.scrollTo({top:0,behavior:'smooth'}); setTimeout(()=>$('#f-vendor').focus(),250);
}
function clearForm(){ editId=null; formFile=null; formUnlink=false; formMeta={}; clearAuto(); $('#readStatus').innerHTML=''; $('#invForm').reset(); $('#btnAdd').textContent='Add invoice'; $('#editing').textContent=''; $('#entrySummary').textContent='Add an invoice'; showFormFile(); motionWarn(); }
function clearAuto(){ autoIds.forEach(id=>{ const el=$('#'+id); if(el) el.classList.remove('autofill'); }); autoIds=new Set(); }
function setFormFile(f){ formFile=f; showFormFile(); if(typeof Reader!=='undefined') autoFill(f,false); }
function ownABNs(){ const by={}; STATE.invoices.forEach(x=>(x.abns||[]).forEach(a=>{ (by[a]=by[a]||new Set()).add(norm(x.vendor)); })); return Object.keys(by).filter(a=>by[a].size>=2); }
async function autoFill(file, force){
  const st=$('#readStatus'); const isNew = editId==null;
  st.innerHTML='<span class="spin"></span> Reading the invoice…';
  let r;
  try{ r=await Reader.readInvoice(file, {vendors:[...new Set(STATE.invoices.map(x=>x.vendor).filter(Boolean))], invoices:STATE.invoices, motions:STATE.motions, ownABNs:ownABNs()},
        msg=>{ st.innerHTML='<span class="spin"></span> '+esc(msg); }); }
  catch(e){ console.warn(e); st.innerHTML='<span class="rs warn">Couldn\'t read this file. Fill it in by hand.</span>'; return; }
  if(formFile!==file) return;            // user moved on
  const F=r.fields; formMeta={abn:F.abn, abns:F.abns};
  const map={date:'#f-date',vendor:'#f-vendor',description:'#f-desc',po:'#f-po',invoiceNo:'#f-inv',gross:'#f-gross',gst:'#f-gst',motion:'#f-motion'};
  const filled=[];
  Object.entries(map).forEach(([k,sel])=>{
    if(F[k]==null || F[k]==='') return;
    const el=$(sel); const empty = el.value==='' || autoIds.has(el.id);
    if(!(force || empty)) return;
    if(k==='motion' && ![...el.options].some(o=>o.value===F[k])) return;
    el.value = (k==='gross'||k==='gst')? Number(F[k]).toFixed(2) : F[k];
    el.classList.add('autofill'); autoIds.add(el.id); filled.push(k);
  });
  if(F.stage && (isNew || force)){ $('#f-paid').value=F.stage; $('#f-paid').classList.add('autofill'); autoIds.add('f-paid'); filled.push('stage'); }
  motionWarn();
  const label={date:'date',vendor:'vendor',description:'description',po:'PO',invoiceNo:'invoice no.',gross:'total',gst:'GST',motion:'motion',stage:'stage'};
  const missing=['date','vendor','invoiceNo','gross'].filter(k=>!filled.includes(k) && !$(map[k]).value).map(k=>label[k]);
  let html= filled.length
    ? '<span class="rs ok">Filled '+filled.map(k=>label[k]).join(', ')+(r.method==='ocr'?' (from a scan, so check carefully)':'')+'. Check the highlighted fields.</span>'
    : '<span class="rs warn">Couldn\'t find the details in this file'+(r.method==='ocr'?' (scan was hard to read)':'')+'. Fill it in by hand.</span>';
  const n=r.notes||{}; const extra=Object.entries(n).filter(([k])=>filled.includes(k)).map(([k,v])=>label[k]+': '+v);
  if(extra.length) html+='<span class="rs note">'+esc(extra.join(' · '))+'</span>';
  if(missing.length && filled.length) html+='<span class="rs note">Not found: '+esc(missing.join(', '))+'</span>';
  // duplicate check
  const inv=norm($('#f-inv').value), g=parseFloat($('#f-gross').value||0), v=norm($('#f-vendor').value);
  const dup=STATE.invoices.findIndex((x,i)=> i!==editId && ((inv.length>=3 && norm(x.invoiceNo)===inv && (!v || norm(x.vendor)===v || Math.abs(Number(x.gross||0)-g)<0.01)) || (v && norm(x.vendor)===v && Math.abs(Number(x.gross||0)-g)<0.01 && x.date===$('#f-date').value)));
  if(dup>=0){ const x=STATE.invoices[dup]; html+='<span class="rs dup">Looks like this is already in the register: '+esc(x.vendor)+' · '+esc(x.date)+' · '+money(x.gross)+' <button type="button" class="small" id="btnOpenDup">Open that row</button></span>'; }
  st.innerHTML=html;
  const od=$('#btnOpenDup'); if(od) od.onclick=()=>{ const keep=formFile; loadInvoice(dup); if(!STATE.invoices[dup].file || needsFile(STATE.invoices[dup],fileUses())){ formFile=keep; showFormFile(); $('#readStatus').innerHTML='<span class="rs note">The file will be attached to this row when you click Update.</span>'; } };
}
function showFormFile(){
  const cur = editId!=null && !formUnlink ? (STATE.invoices[editId].file||'') : '';
  const dz=$('#formDrop');
  if(formFile){ $('#formFileName').textContent=formFile.name; $('#formFileHint').textContent='will be attached and renamed when you save ·'; }
  else if(cur){ $('#formFileName').textContent=cur.split('/').pop(); $('#formFileHint').textContent='Drop a different file to replace, or'; }
  else { $('#formFileName').textContent='No invoice file yet'; $('#formFileHint').textContent='Drop the PDF here, or'; }
  $('#btnPickFormFile').textContent = (formFile||cur)? 'Replace' : 'Choose file';
  $('#btnPreviewFormFile').hidden = !cur || !!formFile;
  $('#btnUnlinkFormFile').hidden = !(formFile||cur);
  $('#btnReread').hidden = !formFile;
  dz.classList.toggle('has', !!(formFile||cur));
}

function motionWarn(){
  const el=$('#motionWarn'); const num=$('#f-motion').value; el.textContent=''; el.className='warnline';
  if(!num) return;
  const m=STATE.motions.find(z=>z.number===num); if(!m||!Number(m.allocation)) return;
  const sp=motionSpend(); let used=sp[num]||0;
  if(editId!=null && STATE.invoices[editId].motion===num) used-=Number(STATE.invoices[editId].gross||0);
  const after=used+Number($('#f-gross').value||0), a=Number(m.allocation), left=a-after;
  if(after>a){ el.textContent='Takes this motion '+money(after-a)+' over its '+money(a); el.classList.add('over'); }
  else if(after>=0.85*a){ el.textContent=Math.round(after/a*100)+'% used after this · '+money(left)+' left'; }
  else el.textContent=money(left)+' left on this motion after this';
  if(after<0.85*a) el.style.color='var(--muted)'; else el.style.color='';
}
function renderMotions(){
  $('#motionYear').textContent='('+STATE.year+')';
  const spent={}, cnt={};
  STATE.invoices.forEach(x=>{ if(x.motion){ spent[x.motion]=(spent[x.motion]||0)+Number(x.gross||0); cnt[x.motion]=(cnt[x.motion]||0)+1; }});
  const tb=$('#motTable tbody'); tb.innerHTML='';
  STATE.motions.forEach((m,idx)=>{
    const s=spent[m.number]||0, a=Number(m.allocation||0), rem=a-s, pct=a>0?Math.min(100,Math.round(s/a*100)):0, over=s>a+0.005, near=!over && a>0 && s>=0.85*a;
    const tr=document.createElement('tr'); tr.className= over?'overrow': near?'near':'';
    tr.innerHTML=`<td>${esc(m.number)}</td><td>${esc(m.description)}${over?' <span class="tag Missing">Over</span>':near?' <span class="tag Check">Near limit</span>':''}</td>
      <td class="num">${money(a)}</td><td class="num">${money(s)}</td>
      <td class="num remain">${money(rem)}</td>
      <td class="bar"><div class="barwrap"><div class="barfill ${over?'over':near?'near':''}" style="width:${over?100:pct}%"></div></div><span class="muted">${a>0?Math.round(s/a*100)+'%':'-'}</span></td>
      <td class="num">${cnt[m.number]||0}</td>
      <td><button class="del">&#215;</button></td>`;
    tr.querySelector('.del').onclick=()=>{ if(confirm('Remove motion '+m.number+'?')){ STATE.motions.splice(idx,1); markDirty(); renderAll(); } };
    tb.appendChild(tr);
  });
  const nearN=STATE.motions.filter(m=>{const a=Number(m.allocation||0),s=spent[m.number]||0; return a>0 && s>=0.85*a && s<=a+0.005;}).length;
  const overN=STATE.motions.filter(m=>{const a=Number(m.allocation||0),s=spent[m.number]||0; return s>a+0.005;}).length;
  const totA=STATE.motions.reduce((t,m)=>t+Number(m.allocation||0),0), totS=STATE.motions.reduce((t,m)=>t+(spent[m.number]||0),0);
  $('#motCards').innerHTML=[card('Motions allocated',money(totA)),card('Spent against motions',money(totS)),card('Unspent',money(totA-totS),'good'),
    card('Near limit (85%+)',nearN,nearN?'warn':'good'),card('Over allocation',overN,overN?'over':'good')].join('');
  const mb=$('#motBadge'); mb.hidden=!(nearN+overN); mb.textContent=nearN+overN; mb.title=(overN?overN+' over, ':'')+nearN+' near limit';
  // unallocated
  const un=STATE.invoices.filter(x=>!x.motion).reduce((t,x)=>t+Number(x.gross||0),0);
  if(un>0){ const tr=document.createElement('tr'); tr.style.opacity=.75;
    tr.innerHTML=`<td>-</td><td>Invoices with no motion</td><td class="num">-</td><td class="num">${money(un)}</td><td class="num">-</td><td class="bar"></td><td class="num">${STATE.invoices.filter(x=>!x.motion).length}</td><td></td>`;
    tb.appendChild(tr); }
}

let msgView='unsent';
function budgetFigures(){
  const alloc=STATE.account.allocations.reduce((t,a)=>t+Number(a.amount||0),0);
  const nettOf=l=> l.nett!=null? Number(l.nett): Number(l.gross||0);
  const hasLedger=STATE.ledger.length>0;
  const {regMatched}=matchIndexLedger();
  // a register row counts as "spent" when it's on the ledger (or, with no ledger yet, when it isn't just a committed PO)
  const spentRow=(x,i)=> hasLedger? regMatched.has(i) : !x.committed;
  const totalSpent = hasLedger? STATE.ledger.reduce((t,l)=>t+nettOf(l),0) : STATE.invoices.reduce((t,x,i)=>t+(spentRow(x,i)?exOf(x):0),0);
  const msgSpent = STATE.invoices.reduce((t,x,i)=> t + (x.motion && spentRow(x,i)? exOf(x):0), 0);
  const msgAwaiting = STATE.invoices.reduce((t,x,i)=> t + ((x.motion && spentRow(x,i) && !x.msgPaid)? exOf(x):0), 0);
  const ownSpent = totalSpent - msgSpent;
  const ownRem = alloc - ownSpent;
  const pending = STATE.invoices.reduce((t,x,i)=> t + (!x.motion && !spentRow(x,i)? exOf(x):0), 0);   // committed POs + invoices not yet posted
  const forecast = ownRem - pending;
  return {alloc,totalSpent,msgSpent,msgAwaiting,ownSpent,ownRem,pending,forecast};
}
function renderBudget(){
  const {alloc,totalSpent,msgSpent,msgAwaiting,ownSpent,ownRem,pending,forecast}=budgetFigures();
  const miss=STATE.invoices.filter(x=>needsFile(x,fileUses())).length;
  $('#budgetCards').innerHTML=[
    card('Allocated (ex GST)',money(alloc)),
    card('Total outgoings (ex GST)',money(totalSpent)),
    card('MSG-funded (reimbursable)',money(msgSpent)),
    card('MSG awaiting reimbursement',money(msgAwaiting),msgAwaiting>0?'over':'good'),
    card('Your D5720 spend',money(ownSpent)),
    card('On track: remaining',money(ownRem),ownRem<0?'over':'good'),
    card('Committed, not yet posted',money(pending)),
    card('Forecast remaining',money(forecast),forecast<0?'over':'good hero'),
    card('Invoices to attach',miss,miss>0?'over':'good')
  ].join('');
  $('#budgetNote').textContent='Your D5720 spend strips out MSG-funded items (they net to zero once reimbursed). "On track: remaining" = allocation minus your own posted spend. "Committed, not yet posted" = your non-MSG POs raised and invoices not yet on the RM ledger. "Forecast remaining" is what is genuinely left once those land.';
  renderMsgChase();
  const tb=$('#allocTable tbody'); tb.innerHTML='';
  STATE.account.allocations.forEach((a,idx)=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${esc(a.desc)}</td><td>${esc(a.date||'')}</td><td class="num">${money(a.amount)}</td><td><button class="del">&#215;</button></td>`;
    tr.querySelector('.del').onclick=()=>{ if(confirm('Remove allocation "'+a.desc+'"?')){ STATE.account.allocations.splice(idx,1); markDirty(); renderAll(); } };
    tb.appendChild(tr);
  });
}
function msgRows(){
  const out={unsent:[],sent:[]};
  STATE.invoices.forEach((x,i)=>{ if(!x.motion || x.msgPaid || x.committed) return;
    if(x.msgSent) out.sent.push({x,i,age:daysSince(x.msgSentDate||x.date),from:x.msgSentDate?'sent':'inv'});
    else out.unsent.push({x,i,age:daysSince(x.date),from:'inv'}); });
  out.unsent.sort((a,b)=>(b.age||0)-(a.age||0)); out.sent.sort((a,b)=>(b.age||0)-(a.age||0));
  return out;
}
function renderMsgChase(){
  const R=msgRows(); $('#n-unsent').textContent=R.unsent.length; $('#n-sent').textContent=R.sent.length;
  const mb=$('#msgBadge'); const n=R.unsent.length+R.sent.length; mb.hidden=!n; mb.textContent=n; mb.title=n+' MSG items still to be reimbursed';
  const rows=R[msgView]; const tb=$('#msgTable tbody'); tb.innerHTML='';
  $('#msgTotal').textContent=rows.length+' items · '+money(rows.reduce((t,r)=>t+Number(r.x.gross||0),0));
  rows.forEach(({x,i,age,from})=>{
    const tr=document.createElement('tr');
    const cls= age==null?'': age>60?'old': age>30?'mid':'';
    tr.innerHTML=`<td class="date">${esc(x.date)}</td><td><div class="vend">${esc(x.vendor)}</div><div class="descr">${esc(x.description)}</div></td>
      <td class="motionref">${esc(x.motion)}</td><td class="num">${money(x.gross)}</td>
      <td class="num"><span class="age ${cls}" title="${from==='sent'?'since you marked it sent':'since the invoice date'}">${age==null?'-':age+' days'}</span></td>
      <td style="white-space:nowrap">${msgView==='unsent'?'<button class="small" data-a="sent">Mark sent</button> ':''}<button class="small brass" data-a="paid">Reimbursed</button></td>`;
    const bs=tr.querySelector('[data-a=sent]'); if(bs) bs.onclick=()=>{ setSent(STATE.invoices[i],true); markDirty(); renderAll(); toast('Marked sent to MSG'); };
    tr.querySelector('[data-a=paid]').onclick=()=>{ setReimb(STATE.invoices[i],true); markDirty(); renderAll(); toast('Marked reimbursed'); };
    tb.appendChild(tr);
  });
  if(!rows.length) tb.innerHTML='<tr><td colspan="6" class="muted" style="padding:16px">'+(msgView==='unsent'?'Nothing waiting to be sent to MSG.':'Nothing awaiting MSG reimbursement.')+'</td></tr>';
}
function copyMsgList(){
  const rows=msgRows()[msgView]; if(!rows.length){ toast('Nothing to copy'); return; }
  const head= msgView==='unsent'? 'MSG reimbursement request - items fronted from D5720' : 'MSG reimbursements still outstanding';
  const lines=rows.map(({x,age})=>`${x.motion}  |  ${x.date}  |  ${x.vendor} - ${x.description}  |  ${money(x.gross)}${x.invoiceNo?'  |  Inv '+x.invoiceNo:''}${x.po?'  |  PO '+x.po:''}${msgView==='sent'&&age!=null?'  |  sent '+age+' days ago':''}`);
  const tot=rows.reduce((t,r)=>t+Number(r.x.gross||0),0);
  const txt=head+'\n\n'+lines.join('\n')+'\n\nTotal: '+money(tot);
  navigator.clipboard.writeText(txt).then(()=>toast('Copied '+rows.length+' lines')).catch(()=>toast('Could not copy'));
}
function card(k,v,cls){ return `<div class="card ${cls||''}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`; }

function matchIndexLedger(){
  // links ledger lines and register rows sharing an invoice or PO number (4+ chars)
  const regKeys=STATE.invoices.map(x=>[norm(x.invoiceNo),norm(x.po)].filter(k=>k.length>=4));
  const ledMatched=new Set(), regMatched=new Set(), pairs=[];
  STATE.ledger.forEach((l,li)=>{
    const lk=[norm(l.invoiceNo),norm(l.order)].filter(k=>k.length>=4);
    for(let ri=0; ri<regKeys.length; ri++){
      if(regKeys[ri].some(k=>lk.includes(k))){ ledMatched.add(li); regMatched.add(ri); pairs.push([ri,li]); }
    }
  });
  // fallback for short refs (e.g. "88A"): same invoice no. AND same amount, among rows still unmatched
  STATE.ledger.forEach((l,li)=>{ if(ledMatched.has(li)||l.type==='CHG') return; const k=norm(l.invoiceNo); if(!k) return;
    const ri=STATE.invoices.findIndex((x,i)=>!regMatched.has(i) && norm(x.invoiceNo)===k && Math.abs(Number(x.gross||0)-Number(l.gross||0))<0.01);
    if(ri>=0){ ledMatched.add(li); regMatched.add(ri); pairs.push([ri,li]); } });
  return {ledMatched,regMatched,pairs};
}
/* group matched rows into connected sets and compare their totals */
function amountDiffs(pairs){
  const parent={}; const f=a=>{ while(parent[a]!==a){ parent[a]=parent[parent[a]]; a=parent[a]; } return a; };
  const u=(a,b)=>{ parent[a]??=a; parent[b]??=b; parent[f(a)]=f(b); };
  pairs.forEach(([r,l])=>u('r'+r,'l'+l));
  const groups={}; Object.keys(parent).forEach(k=>{ const g=f(k); (groups[g]=groups[g]||[]).push(k); });
  const out=[];
  Object.values(groups).forEach(ks=>{
    const rs=ks.filter(k=>k[0]==='r').map(k=>+k.slice(1)), ls=ks.filter(k=>k[0]==='l').map(k=>+k.slice(1));
    const rt=rs.reduce((t,i)=>t+Number(STATE.invoices[i].gross||0),0), lt=ls.reduce((t,i)=>t+Number(STATE.ledger[i].gross||0),0);
    if(Math.abs(rt-lt)>0.009) out.push({rs,ls,rt,lt});
  });
  return out;
}
function ledgerToInvoice(l){
  const ord=String(l.order||'').trim(); const isCard=/^pc\d/i.test(ord);
  let vendor=l.vendor||'', desc=l.description||'';
  return {date:l.date||'', vendor, description:desc, po:isCard?'':ord, invoiceNo:l.invoiceNo||'', card:isCard?ord:'', motion:'',
    gross:Number(l.gross||0), gst:l.gst!=null?Number(l.gst):Math.round(Number(l.gross||0)/11*100)/100,
    docStatus:'Missing', paid:true, committed:false, notes:'Added from RM ledger', msgSent:false, msgPaid:false, file:''};
}
function renderReconcile(){
  $('#ledMeta').textContent = STATE.ledger.length? `${STATE.ledger.length} ledger lines · ${STATE.ledgerMeta.source||''}${STATE.ledgerMeta.importedAt?' · imported '+STATE.ledgerMeta.importedAt:''}` : 'No ledger imported yet.';
  const {ledMatched,regMatched,pairs}=matchIndexLedger();
  const diffs=amountDiffs(pairs);
  const spend=STATE.ledger.filter(l=>l.type!=='CHG');
  const unlogged=STATE.ledger.map((l,i)=>({l,i})).filter(({l,i})=>!ledMatched.has(i)&&l.type!=='CHG');
  $('#recCards').innerHTML=[
    card('Ledger spend lines',spend.length),
    card('Matched to a logged invoice',ledMatched.size,'good'),
    card('Ledger lines not logged',unlogged.length,unlogged.length?'over':'good'),
    card('Amount mismatches',diffs.length,diffs.length?'over':'good'),
    card('Logged invoices not on ledger',STATE.invoices.filter((x,i)=>!regMatched.has(i)).length)
  ].join('');
  const rb=$('#recBadge'); rb.hidden=!(unlogged.length+diffs.length); rb.textContent=unlogged.length+diffs.length;
  const t1=$('#recLedger tbody'); t1.innerHTML='';
  $('#btnAddAllLedger').hidden=!unlogged.length;
  unlogged.forEach(({l})=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td class="date">${esc(l.date)}</td><td>${esc(l.vendor)}</td><td>${esc(l.description)}</td><td class="refs">${esc(l.order)}<br>${esc(l.invoiceNo)}</td><td class="num">${money(l.gross)}</td>
      <td style="white-space:nowrap"><button class="small brass">Add to register</button></td>`;
    tr.querySelector('button').onclick=()=>{ STATE.invoices.push(ledgerToInvoice(l)); markDirty(); renderAll(); toast('Added '+(l.vendor||'line')+' — attach its invoice in the Register'); };
    t1.appendChild(tr); });
  if(!t1.children.length) t1.innerHTML='<tr><td colspan="6" class="muted">Everything on the ledger is logged.</td></tr>';
  const t3=$('#recDiff tbody'); t3.innerHTML='';
  diffs.forEach(d=>{
    const x=STATE.invoices[d.rs[0]];
    const refs=[...new Set(d.rs.map(i=>STATE.invoices[i].invoiceNo||STATE.invoices[i].po).filter(Boolean))].join(', ');
    const tr=document.createElement('tr');
    tr.innerHTML=`<td><div class="vend">${esc(x.vendor)}</div><div class="descr">${esc(x.description)}${d.rs.length>1?' (+'+(d.rs.length-1)+' more rows)':''}</div></td>
      <td class="refs">${esc(refs)}</td><td class="num">${money(d.rt)}</td><td class="num">${money(d.lt)}</td><td class="num diff">${money(d.rt-d.lt)}</td>
      <td style="white-space:nowrap"><button class="small" data-a="edit">Edit row</button>${d.rs.length===1?' <button class="small brass" data-a="use" title="Set the register row to the ledger amount">Use ledger amount</button>':''}</td>`;
    tr.querySelector('[data-a=edit]').onclick=()=>{ showTab('register'); loadInvoice(d.rs[0]); };
    const ub=tr.querySelector('[data-a=use]'); if(ub) ub.onclick=()=>{ const r=STATE.invoices[d.rs[0]];
      r.gross=Math.round(d.lt*100)/100; const g=d.ls.reduce((t,i)=>t+(STATE.ledger[i].gst!=null?Number(STATE.ledger[i].gst):0),0); r.gst=Math.round(g*100)/100;
      markDirty(); renderAll(); toast('Amount updated to '+money(d.lt)); };
    t3.appendChild(tr);
  });
  if(!t3.children.length) t3.innerHTML='<tr><td colspan="6" class="muted">Every matched invoice agrees with the ledger.</td></tr>';
  const t2=$('#recReg tbody'); t2.innerHTML='';
  STATE.invoices.forEach((x,i)=>{ if(regMatched.has(i)) return;
    const tr=document.createElement('tr');
    tr.innerHTML=`<td class="date">${esc(x.date)}</td><td>${esc(x.vendor)}</td><td>${esc(x.invoiceNo)}</td><td class="num">${money(x.gross)}</td><td>${stageTag(x)}</td>`;
    t2.appendChild(tr); });
  if(!t2.children.length) t2.innerHTML='<tr><td colspan="5" class="muted">Every logged invoice appears on the ledger.</td></tr>';
}
function showTab(id){ const b=$('#tabs button[data-tab="'+id+'"]'); if(b) b.click(); }

/* ---------- forms ---------- */
function wireForms(){
  $('#q').oninput=renderRegister;
  $('#btnClear').onclick=clearForm;
  $('#invForm').onsubmit=e=>{
    e.preventDefault();
    const rec={date:$('#f-date').value, vendor:$('#f-vendor').value.trim(), description:$('#f-desc').value.trim(),
      po:$('#f-po').value.trim(), invoiceNo:$('#f-inv').value.trim(), card:$('#f-card').value.trim(), motion:$('#f-motion').value,
      gross:parseFloat($('#f-gross').value||0), gst:$('#f-gst').value?parseFloat($('#f-gst').value):null,
      docStatus:$('#f-doc').value, paid:$('#f-paid').value==='paid', committed:$('#f-paid').value==='committed', notes:$('#f-notes').value.trim(),
      msgSent:false, msgPaid:false,
      file: (editId!=null && !formUnlink ? (STATE.invoices[editId].file||'') : '')};
    const wasEdit = editId!=null;
    const prev = wasEdit? STATE.invoices[editId] : {};
    if(prev.msgSentDate) rec.msgSentDate=prev.msgSentDate; if(prev.msgPaidDate) rec.msgPaidDate=prev.msgPaidDate;
    setSent(rec,$('#f-sent').checked); if($('#f-reimb').checked) setReimb(rec,true);
    rec.abn = formMeta.abn || prev.abn || ''; rec.abns = formMeta.abns || prev.abns || [];
    if(!rec.abn) delete rec.abn; if(!rec.abns.length) delete rec.abns;
    if(rec.motion==='' ){ rec.msgSent=false; rec.msgPaid=false; delete rec.msgSentDate; delete rec.msgPaidDate; }
    let idx;
    if(wasEdit){ STATE.invoices[editId]=rec; idx=editId; } else { STATE.invoices.push(rec); idx=STATE.invoices.length-1; }
    const pending=formFile;
    markDirty(); clearForm(); renderAll(); toast(wasEdit?'Invoice updated':'Invoice added');
    if(pending) writeAttachment(idx,pending);
    if(!wasEdit) $('#entry').open=true; else $('#entry').open=false;
  };
  ['#f-motion','#f-gross'].forEach(id=>$(id).addEventListener('input',motionWarn));
  $('#btnGst').onclick=()=>{ const g=parseFloat($('#f-gross').value||0); $('#f-gst').value=g? (Math.round(g/11*100)/100).toFixed(2):''; };
  $('#btnPickFormFile').onclick=async()=>{ const f=await pickFile(); if(f) setFormFile(f); };
  $('#btnReread').onclick=()=>{ if(formFile) autoFill(formFile,true); };
  $$('#invForm input, #invForm select').forEach(el=>el.addEventListener('input',()=>{ el.classList.remove('autofill'); autoIds.delete(el.id); }));
  $('#btnPreviewFormFile').onclick=()=>{ if(editId!=null) openDoc(STATE.invoices[editId], editId); };
  $('#btnUnlinkFormFile').onclick=()=>{ if(formFile){ formFile=null; $('#readStatus').innerHTML=''; } else formUnlink=true; showFormFile(); };
  const dz=$('#formDrop');
  dz.addEventListener('dragover',e=>{ e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave',()=>dz.classList.remove('over'));
  dz.addEventListener('drop',e=>{ e.preventDefault(); e.stopPropagation(); dz.classList.remove('over'); const f=e.dataTransfer.files[0]; if(f) setFormFile(f); });
  // stop a stray drop elsewhere from navigating away from the app
  window.addEventListener('dragover',e=>e.preventDefault());
  // dropping an invoice anywhere else on the Register starts a new entry and reads it
  window.addEventListener('drop',e=>{ e.preventDefault();
    const f=e.dataTransfer && e.dataTransfer.files[0]; if(!f || !$('#register').classList.contains('active')) return;
    if(editId!=null) clearForm(); setFormFile(f); $('#entry').open=true; window.scrollTo({top:0,behavior:'smooth'}); });
  $$('#chips .chip').forEach(b=>b.onclick=()=>{ regFilter=b.dataset.f; $$('#chips .chip').forEach(x=>x.classList.toggle('active',x===b)); renderRegister(); });
  $('#btnScan').onclick=scanFolder;
  $('#pvClose').onclick=closePreview;
  $('#pvTab').onclick=()=>{ if(pvUrl) window.open(pvUrl,'_blank'); };
  $('#pvReplace').onclick=async()=>{ const i=pvIndex; if(i==null) return; const f=await pickFile(); if(f){ closePreview(); await writeAttachment(i,f); } };
  $('#scanClose').onclick=()=>$('#scanModal').classList.remove('show');
  $('#scanLinkStrong').onclick=()=>{ const n=scanMatches.filter(m=>m.score>=3 && !m.done); n.forEach(linkMatch); $('#scanModal').classList.remove('show'); toast('Linked '+n.length+' invoice file'+(n.length===1?'':'s')); };
  $$('.modal').forEach(m=>m.addEventListener('click',e=>{ if(e.target===m){ m.id==='previewModal'? closePreview() : m.classList.remove('show'); } }));
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closePreview(); $('#scanModal').classList.remove('show'); } });
  $('#btnReconnect').onclick=()=>checkFolderAccess(true);
  $$('#msgChips .chip').forEach(b=>b.onclick=()=>{ msgView=b.dataset.m; $$('#msgChips .chip').forEach(x=>x.classList.toggle('active',x===b)); renderMsgChase(); });
  $('#btnCopyMsg').onclick=copyMsgList;
  $('#btnAddAllLedger').onclick=()=>{ const {ledMatched}=matchIndexLedger(); const add=STATE.ledger.filter((l,i)=>!ledMatched.has(i)&&l.type!=='CHG');
    if(!add.length) return; if(!confirm('Add '+add.length+' ledger lines to the register? Each comes in as paid, flagged Missing invoice.')) return;
    add.forEach(l=>STATE.invoices.push(ledgerToInvoice(l))); markDirty(); renderAll(); toast('Added '+add.length+' lines'); };
  $('#btnBannerConnect').onclick=()=>{ if(dirHandle) checkFolderAccess(true); else chooseWorkspace(); };
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
  $('#btnReseed').onclick=async()=>{
    const t=prompt('This replaces everything on screen with the 2026 sample.\n\nType RESET to continue.');
    if(t!=='RESET') return;
    try{ STATE=await (await fetch('seed.json',{cache:'no-store'})).json(); markDirty(); renderAll(); toast('2026 sample loaded'); }catch(e){ toast('Could not load sample'); } };
  $('#btnNewYear').onclick=async()=>{
    const y=prompt('Start a new year.\n\nFirst an archive copy (tally-'+STATE.year+'.json) is saved. Then invoices, ledger and allocations are cleared; motions are kept as a template and committed POs carry over.\n\nNew year:', String(STATE.year+1));
    if(!y) return;
    const archiveName='tally-'+STATE.year+'.json';
    let archived=false;
    if(dirHandle && await needFolder()){ try{ await writeFolderJSON(archiveName, STATE); archived=true; }catch(e){ console.warn(e); } }
    if(!archived){
      const blob=new Blob([JSON.stringify(STATE,null,1)],{type:'application/json'});
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=archiveName; a.click(); URL.revokeObjectURL(a.href);
      if(!confirm('The archive was downloaded as '+archiveName+' (the Finance folder is not connected). Check it is in your Downloads, then OK to clear the year.')) return;
    }
    const carry=STATE.invoices.filter(x=>x.committed).map(x=>Object.assign({},x,{notes:((x.notes||'')+' [carried from '+STATE.year+']').trim()}));
    STATE.year=parseInt(y,10)||STATE.year;
    STATE.invoices=carry; STATE.ledger=[]; STATE.ledgerMeta={};
    STATE.account.allocations=[];
    markDirty(); renderAll(); toast('Archived '+archiveName+' · '+STATE.year+' started'+(carry.length?' with '+carry.length+' committed POs':''));
  };
  $('#optAutosave').checked=autosaveOn();
  $('#optAutosave').onchange=e=>{ try{ localStorage.setItem('tally-autosave', e.target.checked?'1':'0'); }catch(_){} if(e.target.checked && dirty) autoSave(); toast(e.target.checked?'Autosave on':'Autosave off'); };
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
      STATE.ledger=out; STATE.ledgerMeta={source:f.name,importedAt:today()};
      const {regMatched}=matchIndexLedger(); let flipped=0;
      regMatched.forEach(i=>{ const x=STATE.invoices[i]; if(!x.paid||x.committed){ x.paid=true; x.committed=false; flipped++; } });
      markDirty(); renderAll(); toast('Imported '+out.length+' ledger lines'+(flipped?' · '+flipped+' now marked paid':''));
    }catch(err){ console.warn(err); toast('Could not read that file'); }
    finally{ e.target.value=''; }
  };
  r.readAsArrayBuffer(f);
}

function exportXlsx(){
  const wb=XLSX.utils.book_new();
  // Budget summary (net of MSG)
  const B=budgetFigures();
  const bud=[['D5720 Budget ('+STATE.year+')','ex GST'],
    ['Allocated',B.alloc],['Total outgoings (incl MSG layer)',B.totalSpent],
    ['Less: MSG-funded (reimbursable)',-B.msgSpent],['Your D5720 spend',B.ownSpent],
    ['On track: remaining',B.ownRem],['Committed, not yet posted',B.pending],['Forecast remaining',B.forecast],
    [],['MSG awaiting reimbursement',B.msgAwaiting]];
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(bud),'Budget');
  // Register
  const reg=[['Date','Vendor','Description','PO','Invoice','Card','MSG Motion','Gross','GST','Check flag','Stage','MSG sent','MSG reimbursed','Invoice file','Notes']];
  STATE.invoices.slice().sort((a,b)=>(a.date||'').localeCompare(b.date||'')).forEach(x=>
    reg.push([x.date,x.vendor,x.description,x.po,x.invoiceNo,x.card,x.motion,x.gross,x.gst,x.docStatus,stageOf(x),x.msgSent?(x.msgSentDate||'Yes'):'',x.msgPaid?(x.msgPaidDate||'Yes'):'',x.file||'',x.notes]));
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(reg),'Register');
  // Motion tally
  const spent={}; STATE.invoices.forEach(x=>{ if(x.motion) spent[x.motion]=(spent[x.motion]||0)+Number(x.gross||0); });
  const mt=[['MSG Motion','Purpose','Allocation','Spent','Remaining']];
  STATE.motions.forEach(m=>mt.push([m.number,m.description,m.allocation,spent[m.number]||0,Number(m.allocation||0)-(spent[m.number]||0)]));
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(mt),'Motion Tally');
  const R=msgRows(); const mc=[['Status','Motion','Date','Vendor','Description','Gross','Invoice','PO','Days waiting']];
  [['Not sent',R.unsent],['Sent, awaiting',R.sent]].forEach(([lab,rows])=>rows.forEach(({x,age})=>mc.push([lab,x.motion,x.date,x.vendor,x.description,x.gross,x.invoiceNo,x.po,age])));
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(mc),'MSG to chase');
  XLSX.writeFile(wb,'Tally reconciliation '+STATE.year+'.xlsx');
  toast('Workbook exported');
}

window.addEventListener('beforeunload', e=>{ if(dirty){ e.preventDefault(); e.returnValue=''; } });
