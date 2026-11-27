const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
function sonyVideo(value){
  try{
    const u=new URL(value);
    return u.protocol==='https:' && !u.username && !u.password && !u.port &&
      u.hostname.endsWith('.dl.playstation.net') && /\.mp4$/i.test(u.pathname);
  }catch{return false;}
}
async function sendTrailer(req,res,url){
  if(!sonyVideo(url))return res.sendStatus(404);
  if(req.headers.range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(req.headers.range))return res.sendStatus(416);
  const abort=new AbortController();
  res.on('close',()=>abort.abort());
  const timeout=setTimeout(()=>abort.abort(),15000);
  try{
    let upstream;
    for(let i=0;i<4;i++){
      upstream=await fetch(url,{redirect:'manual',signal:abort.signal,headers:req.headers.range?{Range:req.headers.range}:{}});
      if(![301,302,303,307,308].includes(upstream.status))break;
      await upstream.body?.cancel();
      url=new URL(upstream.headers.get('location'),url).href;
      if(!sonyVideo(url))throw Error('Invalid video source');
    }
    clearTimeout(timeout);
    if(![200,206,416].includes(upstream.status))throw Error('Video unavailable');
    res.status(upstream.status);
    for(const h of ['content-range','content-length','accept-ranges'])if(upstream.headers.has(h))res.set(h,upstream.headers.get(h));
    res.type('video/mp4');
    if(upstream.body)await pipeline(Readable.fromWeb(upstream.body),res);else res.end();
  }catch{if(!res.destroyed && !res.headersSent)res.sendStatus(502);else res.destroy();}
  finally{clearTimeout(timeout);abort.abort();}
}
module.exports={sonyVideo,sendTrailer};
