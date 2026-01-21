
(() => {
  const canvas = document.getElementById("snowCanvas");
  try{
    const v = localStorage.getItem("ps95_snow");
    if(v==="0"){ canvas.style.display="none"; return; }
  }catch(_){/* ignore */}

  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: true });

  let W = 0, H = 0, dpr = 1;
  const flakes = [];
  let targetCount = 90;

  const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) return;

  function resize() {
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    W = Math.floor(window.innerWidth);
    H = Math.floor(window.innerHeight);
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // scale amount of flakes with area
    const area = W * H;
    targetCount = Math.max(50, Math.min(140, Math.floor(area / 14000)));
    while (flakes.length < targetCount) flakes.push(makeFlake(true));
    if (flakes.length > targetCount) flakes.length = targetCount;
  }

  function rand(min, max) { return min + Math.random() * (max - min); }

  function makeFlake(initial=false) {
    const r = rand(1.2, 3.2);
    return {
      x: rand(0, W),
      y: initial ? rand(0, H) : rand(-H * 0.15, -10),
      r,
      vy: rand(0.45, 1.25) * (r / 2.2),
      vx: rand(-0.35, 0.35),
      sway: rand(0.6, 1.4),
      phase: rand(0, Math.PI * 2),
      alpha: rand(0.45, 0.9)
    };
  }

  function step(t) {
    ctx.clearRect(0, 0, W, H);

    // subtle glow layer (Timeweb vibe)
    for (let i = 0; i < flakes.length; i++) {
      const f = flakes[i];
      const drift = Math.sin((t * 0.001) * f.sway + f.phase) * 0.35;

      f.y += f.vy;
      f.x += f.vx + drift;

      if (f.y > H + 12) {
        flakes[i] = makeFlake(false);
        continue;
      }
      if (f.x < -20) f.x = W + 20;
      if (f.x > W + 20) f.x = -20;

      ctx.beginPath();
      ctx.fillStyle = `rgba(230, 237, 246, ${f.alpha})`;
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }

    requestAnimationFrame(step);
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("storage",(e)=>{
    if(e.key==="ps95_snow"){
      const off = (e.newValue==="0");
      canvas.style.display = off ? "none" : "block";
    }
  });

  resize();
  requestAnimationFrame(step);
})();
