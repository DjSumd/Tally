'use strict';
/* Tally invoice reader — runs entirely in the browser, nothing leaves the PC.
   Digital PDFs: text layer via pdf.js. Scans / photos: OCR via Tesseract (loaded on first use).
   readInvoice(file, ctx) -> {fields, found:[names], method, text, warnings:[]}  */

const Reader = (() => {
  const base = new URL('.', location.href).href;
  let ocrWorker = null;

  /* ---------- text extraction ---------- */
  async function pdfLines(buf){
    if(!window.pdfjsLib) throw new Error('pdf.js missing');
    pdfjsLib.GlobalWorkerOptions.workerSrc = base+'lib/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({data:buf}).promise;
    const lines=[]; const pages=Math.min(pdf.numPages,3);
    for(let p=1;p<=pages;p++){
      const page=await pdf.getPage(p); const tc=await page.getTextContent();
      // rebuild visual lines: group items by y, sort by x
      const rows=[];
      tc.items.forEach(it=>{ if(!it.str || !it.str.trim()) return;
        const y=it.transform[5], x=it.transform[4];
        let r=rows.find(r=>Math.abs(r.y-y)<3); if(!r){ r={y,items:[]}; rows.push(r); }
        r.items.push({x,s:it.str,w:it.width||0}); });
      rows.sort((a,b)=>b.y-a.y);
      rows.forEach(r=>{ r.items.sort((a,b)=>a.x-b.x);
        let line='', lastEnd=null;
        r.items.forEach(i=>{ if(lastEnd!=null) line += (i.x-lastEnd>12)? '   ' : (i.x-lastEnd>1.5? ' ':''); line+=i.s; lastEnd=i.x+i.w; });
        lines.push(line.replace(/\s+$/,'')); });
    }
    return {lines, pdf};
  }
  async function ensureOcr(onStatus){
    if(ocrWorker) return ocrWorker;
    if(!window.Tesseract){
      onStatus && onStatus('Loading text recognition (first time only)…');
      await new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=base+'lib/ocr/tesseract.min.js'; s.onload=res; s.onerror=()=>rej(new Error('OCR library failed to load')); document.head.appendChild(s); });
    }
    ocrWorker = await Tesseract.createWorker('eng', 1, {
      workerPath: base+'lib/ocr/worker.min.js', corePath: base+'lib/ocr', langPath: base+'lib/ocr/lang', gzip:true });
    return ocrWorker;
  }
  async function ocrSource(src, onStatus){
    const w=await ensureOcr(onStatus);
    onStatus && onStatus('Reading the scan…');
    const { data } = await w.recognize(src);
    return data.text.split(/\n/).map(s=>s.trim()).filter(Boolean);
  }
  async function pdfPageCanvas(pdf, n){
    const page=await pdf.getPage(n); const vp=page.getViewport({scale:2.2});
    const c=document.createElement('canvas'); c.width=vp.width; c.height=vp.height;
    await page.render({canvasContext:c.getContext('2d'), viewport:vp}).promise; return c;
  }
  async function extract(file, onStatus){
    const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
    if(isPdf){
      const buf=await file.arrayBuffer();
      const {lines,pdf}=await pdfLines(buf);
      if(lines.join('').replace(/\s/g,'').length>60) return {lines, method:'text'};
      // scanned PDF: OCR the first two pages
      let out=[]; for(let p=1;p<=Math.min(pdf.numPages,2);p++){ out=out.concat(await ocrSource(await pdfPageCanvas(pdf,p), onStatus)); }
      return {lines:out, method:'ocr'};
    }
    if(/^image\//.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name)) return {lines: await ocrSource(file, onStatus), method:'ocr'};
    throw new Error('Not a PDF or image');
  }

  /* ---------- parsing helpers ---------- */
  const MON={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
  const pad=n=>String(n).padStart(2,'0');
  function validISO(y,m,d){ y=+y; m=+m; d=+d; if(y<100) y+=2000; if(m<1||m>12||d<1||d>31||y<2015||y>2040) return null; return y+'-'+pad(m)+'-'+pad(d); }
  function datesIn(s){
    const out=[]; let m;
    const re1=/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g;               // AU d/m/y
    while((m=re1.exec(s))){ const v=validISO(m[3],m[2],m[1]); if(v) out.push({v,i:m.index}); }
    const re2=/\b(\d{4})-(\d{2})-(\d{2})\b/g;
    while((m=re2.exec(s))){ const v=validISO(m[1],m[2],m[3]); if(v) out.push({v,i:m.index}); }
    const re3=/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/gi;
    while((m=re3.exec(s))){ const v=validISO(m[3],MON[m[2].toLowerCase()],m[1]); if(v) out.push({v,i:m.index}); }
    const re4=/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi;
    while((m=re4.exec(s))){ const v=validISO(m[3],MON[m[1].toLowerCase()],m[2]); if(v) out.push({v,i:m.index}); }
    return out.sort((a,b)=>a.i-b.i).map(o=>o.v);
  }
  function moneyIn(s){
    const out=[]; const re=/(-)?\$?\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?!\d)/g; let m;
    while((m=re.exec(s))){ const pre=s.slice(Math.max(0,m.index-1),m.index); if(/[\d\/]/.test(pre)) continue;
      out.push((m[1]?-1:1)*parseFloat(m[2].replace(/,/g,'')+'.'+m[3])); }
    return out;
  }
  const nrm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');

  function findTotal(L){
    const pri=[
      [/\b(invoice\s+total|total\s+(?:amount\s+)?(?:inc|incl|including)\.?\s*gst|total\s+\(?inc|total\s+aud|grand\s+total|total\s+payable|amount\s+paid|total\s+paid)\b/i,4],
      [/\b(amount\s+due|balance\s+due|total\s+due|amount\s+payable|please\s+pay)\b/i,3],
      [/^\s*total\b|\btotal\s*[:$]|\btotal\s*$/i,2]];
    const bad=/sub\s*-?total|total\s+(gst|tax)|ex\.?\s*gst|excl|exclusive|before\s+gst|gst\s+total|discount/i;
    let best=null;
    L.forEach((ln,i)=>{ pri.forEach(([re,p])=>{ if(!re.test(ln)||bad.test(ln)) return;
      let vals=moneyIn(ln); if(!vals.length && L[i+1]) vals=moneyIn(L[i+1]);
      vals=vals.filter(v=>v>0); if(!vals.length) return;
      const v=vals[vals.length-1];
      if(!best || p>best.p || (p===best.p && v>best.v)) best={v,p}; }); });
    if(best) return best.v;
    const all=L.flatMap(moneyIn).filter(v=>v>0); return all.length? Math.max(...all) : null;
  }
  function findGst(L, total){
    const whole=L.join('\n');
    if(/not\s+registered\s+for\s+gst|no\s+gst\s+(?:has\s+been\s+)?(?:charged|applicable)|gst[-\s]?free|gst\s*:?\s*(?:n\/a|nil)/i.test(whole)) return 0;
    let m=whole.match(/(?:includes?|including|incl\.?)\s+(?:total\s+)?gst\s+(?:of\s+)?\$?\s?(\d[\d,]*\.\d{2})/i);
    if(m) return parseFloat(m[1].replace(/,/g,''));
    let cands=[];
    L.forEach((ln,i)=>{ if(!/\bgst\b|\btax\b/i.test(ln) || /abn|registered|ex\.?\s*gst|excl|exclusive|before|inc(?:l|luding)?\.?\s*gst|tax\s+invoice/i.test(ln)) return;
      let vals=moneyIn(ln); if(!vals.length && L[i+1]) vals=moneyIn(L[i+1]);
      vals.filter(v=>v>=0).forEach(v=>cands.push(v)); });
    if(total) cands=cands.filter(v=>v<=total*0.1+0.06);
    if(cands.length){ if(total){ const t=total/11; cands.sort((a,b)=>Math.abs(a-t)-Math.abs(b-t)); } return cands[0]; }
    return null;
  }
  function findDate(L){
    const lab=/\b(invoice|issue[d]?|tax\s+invoice|receipt|order|transaction|purchase|payment|document)?\s*date\b/i;
    for(let i=0;i<L.length;i++){ const ln=L[i]; if(!lab.test(ln) || /\bdue\b/i.test(ln)) continue;
      const after=ln.slice(ln.search(lab)); let d=datesIn(after); if(!d.length && L[i+1]) d=datesIn(L[i+1]); if(d.length) return d[0]; }
    for(const ln of L){ if(/\bdue\b|expir|valid\s+until/i.test(ln)) continue; const d=datesIn(ln); if(d.length) return d[0]; }
    return null;
  }
  const REFTOK='([A-Z0-9][A-Z0-9\\-\\/_.]*\\d[A-Z0-9\\-\\/_.]*)';
  function findInvoiceNo(L, po){
    const pats=[
      [new RegExp('\\b(?:tax\\s+)?invoice\\s*(?:no\\.?|number|num|#|id)\\s*[:#.]?\\s*'+REFTOK,'i'),5],
      [new RegExp('\\binv(?:oice)?\\s*[:#]\\s*'+REFTOK,'i'),4],
      [new RegExp('\\b(?:tax\\s+)?invoice\\s+'+'([A-Z]{1,6}[-\\/]?\\d{2,}[A-Z0-9\\-\\/]*)','i'),4],
      [new RegExp('\\breceipt\\s*(?:no\\.?|number|#|id)?\\s*[:#.]?\\s*'+REFTOK,'i'),3],
      [new RegExp('\\b(?:order|transaction|reference|ref|document)\\s*(?:no\\.?|number|#|id)\\s*[:#.]?\\s*'+REFTOK,'i'),2]];
    let best=null;
    L.forEach((ln,i)=>{ pats.forEach(([re,p])=>{
      let m=ln.match(re);
      // label alone at the end of a line, value on the next line
      if(!m && p>=3 && L[i+1] && /\b(?:invoice|receipt)\s*(?:no\.?|number|num|#|id)\s*[:#.]?\s*$/i.test(ln)){
        const nx=L[i+1].trim().split(/\s+/)[0]; if(/\d/.test(nx) && /^[A-Z0-9][A-Z0-9\-\/_.]*$/i.test(nx)) m=[null,nx]; }
      if(!m) return; const v=m[1].replace(/[.,]$/,'');
      if(po && nrm(v)===nrm(po)) return; if(/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(v)) return;
      if(!best || p>best.p) best={v,p}; }); });
    return best? best.v : null;
  }
  function findPO(L){
    const re=/\b(?:p\.?\s?o\.?|purchase\s*order|your\s*(?:order|ref(?:erence)?)|customer\s*(?:order|ref(?:erence)?)|school\s*order)\s*(?:no\.?|number|#)?\s*[:#.]?\s*(?:po)?\s*(\d{5,7})\b/i;
    for(const ln of L){ const m=ln.match(re); if(m) return m[1]; }
    for(const ln of L){ const m=ln.match(/\bPO\s?(\d{6})\b/i) || ln.match(/\b(5[3-5]\d{4})\b/); if(m && !/abn|phone|ph|tel|bsb|acc/i.test(ln)) return m[1]; }
    return null;
  }
  function findABN(L){
    const out=[]; L.forEach(ln=>{ const re=/\bA\.?\s?B\.?\s?N\.?\s*[:#]?\s*((?:\d\s*){11})/gi; let m; while((m=re.exec(ln))) out.push(m[1].replace(/\s/g,'')); });
    return out;
  }
  const GENERIC=/^(tax\s+)?(invoice|receipt|statement|quote|quotation|bill|page\b|date|abn|acn|phone|ph\b|tel|email|e-mail|www\.|http|bill\s+to|invoice\s+to|ship\s+to|to:|from:|description|qty|item|amount|total|gst|paid|due)/i;
  function findVendor(L, ctx){
    const text=nrm(L.join(' '));
    // 1. a vendor already in the register whose name appears in the document
    let best=null;
    (ctx.vendors||[]).forEach(v=>{ const n=nrm(v); if(n.length<5 || /^(purchasingcards)$/.test(n)) return;
      if(text.includes(n) && (!best || n.length>nrm(best).length)) best=v; });
    if(best) return {v:best,known:true};
    // 1b. near-miss spelling (OCR slips like "Qliff" for "Oliff") in the top of the document
    const head=nrm(L.slice(0,20).join(' ')).slice(0,900);
    (ctx.vendors||[]).forEach(v=>{ const n=nrm(v); if(n.length<7) return; const tol=n.length>=12?2:1;
      for(let i=0;i+n.length<=head.length;i++){ if(lev(head.substr(i,n.length),n,tol)<=tol){ if(!best||n.length>nrm(best).length) best=v; break; } } });
    if(best) return {v:best,known:true};
    // 2. a company-looking line near the top
    const top=L.slice(0,25).filter(ln=>!/mount\s+lawley|mlshs|department\s+of\s+education/i.test(ln));
    let co=top.find(ln=>/\b(pty\.?\s*ltd|pty\s+limited|limited|ltd\.?|inc\.?|t\/as|trading\s+as)\b/i.test(ln));
    if(co) return {v:clean(co.replace(/\b(t\/as|trading\s+as)\b.*/i,'')), known:false};
    // 3. first non-generic text line
    co=top.find(ln=>{ const t=ln.trim(); return t.length>=3 && /[a-z]/i.test(t) && !GENERIC.test(t) && !/\d{3,}/.test(t) && !/@/.test(t) && t.split(/\s+/).length<=7; });
    return co? {v:clean(co),known:false} : null;
  }
  function lev(a,b,max){ if(a===b) return 0; let prev=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){ const cur=[i]; let rowMin=i;
      for(let j=1;j<=b.length;j++){ cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1)); if(cur[j]<rowMin) rowMin=cur[j]; }
      if(rowMin>max) return max+1; prev=cur; } return prev[b.length]; }
  function clean(s){ return String(s).split(/\s{3,}/)[0].replace(/\b(abn|acn)\b.*$/i,'').replace(/[|:,–-]+\s*$/,'').trim().slice(0,60); }
  function findDescription(L){
    const hi=L.findIndex(ln=>/\b(description|item|details|service|product|particulars)\b/i.test(ln) && !/\btotal\b/i.test(ln));
    const start = hi>=0? hi+1 : 0;
    for(let i=start;i<Math.min(L.length,start+12);i++){
      const t=L[i].split(/\s{3,}/)[0].replace(/\$?\s?\d[\d,]*\.\d{2}/g,'').replace(/^\s*\d+\s*(x|×)?\s+/,'').trim();
      if(t.length>=4 && /[a-z]{3}/i.test(t) && !GENERIC.test(t) && !/sub\s*total|gst|balance|thank|payment|bank|bsb|account/i.test(t)) return t.slice(0,60);
    }
    return null;
  }
  function findStage(L){
    const w=L.join('\n');
    if(/\b(paid\s+in\s+full|payment\s+received|amount\s+paid|paid\s+with|paid\s+by|receipt|status\s*:?\s*paid)\b/i.test(w)) return 'paid';
    const due=w.match(/(?:amount|balance|total)\s+due[^\d\n]*\$?\s?(\d[\d,]*\.\d{2})/i);
    if(due) return parseFloat(due[1].replace(/,/g,''))===0? 'paid' : 'unpaid';
    if(/\bdue\s+date\b|please\s+pay|payment\s+terms/i.test(w)) return 'unpaid';
    return null;
  }
  function suggestMotion(ctx, vendor, text, desc){
    const hist=(ctx.invoices||[]).filter(x=>x.motion && vendor && nrm(x.vendor)===nrm(vendor)).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
    const words=(String(desc||'')+' '+text).toLowerCase();
    const STOP=/^(2026|2027|music|mlshs|and|the|for|etc|term|concert)$/;
    let best=null;
    (ctx.motions||[]).forEach(m=>{
      const toks=String(m.description||'').toLowerCase().split(/[^a-z]+/).filter(t=>t.length>=5 && !STOP.test(t));
      let sc=toks.filter(t=>words.includes(t.slice(0,Math.max(5,t.length-2)))).length, why='matches the motion purpose';
      if(hist.length && hist[0].motion===m.number){ sc+=1.5; why= sc>1.5? 'same vendor as before, and matches the purpose' : 'same vendor as before'; }
      if(sc>0 && (!best || sc>best.sc)) best={m:m.number,sc,why}; });
    return best;
  }
  async function readInvoice(file, ctx, onStatus){
    onStatus && onStatus('Reading '+file.name+'…');
    const {lines, method} = await extract(file, onStatus);
    const L=lines.map(s=>s.replace(/ /g,' ')).filter(s=>s.trim());
    const text=L.join('\n');
    const f={}, notes={};
    const po=findPO(L); if(po) f.po=po;
    const abns=findABN(L); if(abns.length){ f.abns=abns; const own=new Set(ctx.ownABNs||[]); const a=abns.find(x=>!own.has(x)); if(a) f.abn=a; }
    let vend=null;
    if(f.abn){ const prev=(ctx.invoices||[]).find(x=>x.abn===f.abn); if(prev) vend={v:prev.vendor,known:true}; }
    if(!vend) vend=findVendor(L, ctx);
    if(vend){ f.vendor=vend.v; if(!vend.known) notes.vendor='new vendor — check the name'; }
    const inv=findInvoiceNo(L, po); if(inv) f.invoiceNo=inv;
    const date=findDate(L); if(date) f.date=date;
    const total=findTotal(L); if(total!=null) f.gross=total;
    let gst=findGst(L,total);
    if(gst==null && total && /tax\s+invoice/i.test(text)){ gst=Math.round(total/11*100)/100; notes.gst='estimated as 1/11'; }
    if(gst!=null) f.gst=gst;
    let desc=findDescription(L);
    if(vend && vend.known){ const prev=(ctx.invoices||[]).filter(x=>nrm(x.vendor)===nrm(vend.v)).sort((a,b)=>(b.date||'').localeCompare(a.date||''))[0];
      if(!desc && prev) { desc=prev.description; notes.description='copied from the last invoice from this vendor'; } }
    if(desc) f.description=desc;
    const st=findStage(L); if(st) f.stage=st;
    const mot=suggestMotion(ctx, f.vendor, text, desc); if(mot){ f.motion=mot.m; notes.motion='suggested: '+mot.why; }
    return {fields:f, notes, method, text};
  }
  return { readInvoice, _test:{datesIn,moneyIn,findTotal,findGst,findInvoiceNo,findPO,findDate} };
})();
