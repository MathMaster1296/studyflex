// Confetti, hand-rolled on one canvas. Fired when a session lands.
// Skipped entirely under prefers-reduced-motion.

const COLORS = ['#2F7D46', '#2A6FBF', '#C08A1F', '#C0453A', '#4CAF6E', '#5E9BE0'];

let canvas = null;

export function confetti(strength = 1) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:99';
    document.body.appendChild(canvas);
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const count = Math.round(90 * strength);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const fromLeft = i % 2 === 0;
    parts.push({
      x: fromLeft ? -10 : innerWidth + 10,
      y: innerHeight * (0.25 + Math.random() * 0.35),
      vx: (fromLeft ? 1 : -1) * (4 + Math.random() * 7),
      vy: -(6 + Math.random() * 6),
      w: 5 + Math.random() * 5,
      h: 3 + Math.random() * 4,
      color: COLORS[i % COLORS.length],
      spin: (Math.random() - 0.5) * 0.35,
      angle: Math.random() * Math.PI,
      wobble: Math.random() * Math.PI * 2,
    });
  }

  const started = performance.now();
  function frame(now) {
    const t = (now - started) / 1000;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (t > 2.8) { canvas.remove(); canvas = null; return; }
    for (const p of parts) {
      p.vy += 0.22;                      // gravity
      p.vx *= 0.985;                     // drag
      p.x += p.vx + Math.sin(p.wobble += 0.1);
      p.y += p.vy;
      p.angle += p.spin;
      const fade = Math.max(0, Math.min(1, 2.4 - t));
      if (p.y > innerHeight + 20) continue;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * (0.4 + Math.abs(Math.sin(p.wobble)) * 0.6));
      ctx.restore();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
