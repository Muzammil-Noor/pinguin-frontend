import { WhiteboardPayload } from './whiteboard.service';

/**
 * Board background. Painted as real pixels at the start of every replay rather than left to
 * CSS, for two reasons: the flood fill needs opaque pixels to spread across, and a PNG export
 * should not come out with a transparent background.
 */
export const BOARD_BG = '#101018';

/**
 * How far a pixel may differ from the clicked one and still count as part of the same region.
 * Strokes are drawn antialiased, so their edges fade gradually into the background; with a
 * tolerance of zero a fill would stop dead at the first blended pixel and leave a halo.
 */
const FILL_TOLERANCE = 40;

export function renderOp(ctx: CanvasRenderingContext2D, payload: WhiteboardPayload) {
  switch (payload.t) {
    case 'stroke':
      drawStroke(ctx, payload.c, payload.w, payload.p);
      return;
    case 'shape':
      drawShape(ctx, payload);
      return;
    case 'fill':
      floodFill(ctx, payload.x, payload.y, payload.c);
      return;
  }
}

export function paintBackground(ctx: CanvasRenderingContext2D) {
  ctx.save();
  ctx.fillStyle = BOARD_BG;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

/** Freehand path. `p` is flattened [x0,y0,x1,y1,...]. */
export function drawStroke(ctx: CanvasRenderingContext2D, color: string, width: number, p: number[]) {
  const n = Math.floor(p.length / 2);
  if (n === 0) return;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // A tap with no movement is a dot, which a zero-length path would not render.
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);

  if (n === 2) {
    ctx.lineTo(p[2], p[3]);
  } else {
    // Curve through the midpoints, using each raw sample as a control point. This smooths
    // pointer jitter without letting the rendered line lag behind the cursor.
    for (let i = 1; i < n - 1; i++) {
      const cx = p[i * 2];
      const cy = p[i * 2 + 1];
      const mx = (cx + p[(i + 1) * 2]) / 2;
      const my = (cy + p[(i + 1) * 2 + 1]) / 2;
      ctx.quadraticCurveTo(cx, cy, mx, my);
    }
    ctx.lineTo(p[(n - 1) * 2], p[(n - 1) * 2 + 1]);
  }

  ctx.stroke();
  ctx.restore();
}

export function drawShape(
  ctx: CanvasRenderingContext2D,
  s: { s: 'line' | 'rect' | 'ellipse'; c: string; w: number; x0: number; y0: number; x1: number; y1: number }
) {
  ctx.save();
  ctx.strokeStyle = s.c;
  ctx.lineWidth = s.w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  if (s.s === 'line') {
    ctx.moveTo(s.x0, s.y0);
    ctx.lineTo(s.x1, s.y1);
  } else if (s.s === 'rect') {
    ctx.rect(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0));
  } else {
    ctx.ellipse(
      (s.x0 + s.x1) / 2,
      (s.y0 + s.y1) / 2,
      Math.abs(s.x1 - s.x0) / 2,
      Math.abs(s.y1 - s.y0) / 2,
      0, 0, Math.PI * 2
    );
  }

  ctx.stroke();
  ctx.restore();
}

/**
 * Scanline flood fill.
 *
 * Deliberately span-based rather than the naive four-way recursion: at 1600x900 a per-pixel
 * stack would push over a million entries filling a large region and blow up. This walks each
 * horizontal run in one pass and only stacks seeds for the rows above and below.
 */
export function floodFill(ctx: CanvasRenderingContext2D, fx: number, fy: number, colorHex: string) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  const startX = Math.round(fx);
  const startY = Math.round(fy);
  if (startX < 0 || startY < 0 || startX >= w || startY >= h) return;

  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;

  const startIdx = (startY * w + startX) * 4;
  const tr = data[startIdx];
  const tg = data[startIdx + 1];
  const tb = data[startIdx + 2];
  const ta = data[startIdx + 3];

  const fill = hexToRgb(colorHex);

  // Already this colour -- filling would be a no-op that still costs a full-canvas write.
  if (Math.abs(tr - fill.r) < 2 && Math.abs(tg - fill.g) < 2 && Math.abs(tb - fill.b) < 2 && ta === 255) {
    return;
  }

  const visited = new Uint8Array(w * h);

  const matches = (x: number, y: number): boolean => {
    const pixel = y * w + x;
    if (visited[pixel]) return false;

    const i = pixel * 4;
    return Math.abs(data[i] - tr) <= FILL_TOLERANCE
      && Math.abs(data[i + 1] - tg) <= FILL_TOLERANCE
      && Math.abs(data[i + 2] - tb) <= FILL_TOLERANCE
      && Math.abs(data[i + 3] - ta) <= FILL_TOLERANCE;
  };

  const paint = (x: number, y: number) => {
    const pixel = y * w + x;
    visited[pixel] = 1;

    const i = pixel * 4;
    data[i] = fill.r;
    data[i + 1] = fill.g;
    data[i + 2] = fill.b;
    data[i + 3] = 255;
  };

  const stack: number[] = [startX, startY];

  while (stack.length > 0) {
    const y = stack.pop()!;
    const seedX = stack.pop()!;

    if (!matches(seedX, y)) continue;

    // Walk left to the start of this run.
    let left = seedX;
    while (left > 0 && matches(left - 1, y)) left--;

    // Then sweep right, seeding the neighbouring rows once per contiguous run rather than
    // once per pixel.
    let spanAbove = false;
    let spanBelow = false;

    for (let x = left; x < w && matches(x, y); x++) {
      paint(x, y);

      if (y > 0) {
        const above = matches(x, y - 1);
        if (above && !spanAbove) {
          stack.push(x, y - 1);
          spanAbove = true;
        } else if (!above) {
          spanAbove = false;
        }
      }

      if (y < h - 1) {
        const below = matches(x, y + 1);
        if (below && !spanBelow) {
          stack.push(x, y + 1);
          spanBelow = true;
        } else if (!below) {
          spanBelow = false;
        }
      }
    }
  }

  ctx.putImageData(image, 0, 0);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean;

  const value = parseInt(full, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255
  };
}
