/* Tally service worker - bump CACHE when any cached file changes */
const CACHE = 'tally-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './xlsx.full.min.js',
  './seed.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-64.png'
];
self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', e=>{
  const req=e.request;
  if(req.method!=='GET'){ return; }
  e.respondWith(
    caches.match(req).then(hit=> hit || fetch(req).then(res=>{
      // runtime-cache same-origin GETs
      if(res && res.status===200 && new URL(req.url).origin===location.origin){
        const copy=res.clone(); caches.open(CACHE).then(c=>c.put(req,copy));
      }
      return res;
    }).catch(()=> hit))
  );
});
