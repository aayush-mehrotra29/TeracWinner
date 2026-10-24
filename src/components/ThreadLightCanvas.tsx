"use client";

import { useEffect, useRef } from "react";

type ThreadLightCanvasProps = {
  className?: string;
};

// The four stops from the supplied smoke shader recipe.
const PALETTE = [
  [3, 18, 14],
  [14, 124, 90],
  [124, 229, 119],
  [244, 255, 199],
] as const;

const CELL_SIZE = 8;
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function hash(x: number, y: number) {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + 1;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function noise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (d - c - b + a) * u * v;
}

function fbm(x: number, y: number) {
  return (
    noise(x, y) * 0.57 +
    noise(x * 2.07 + 17.3, y * 2.07 - 9.1) * 0.28 +
    noise(x * 4.13 - 5.4, y * 4.13 + 21.7) * 0.15
  );
}

function paletteColor(value: number): [number, number, number] {
  const position = clamp(value) * 3;
  const index = Math.min(2, Math.floor(position));
  const fraction = position - index;
  const from = PALETTE[index];
  const to = PALETTE[index + 1];
  return [
    from[0] + (to[0] - from[0]) * fraction,
    from[1] + (to[1] - from[1]) * fraction,
    from[2] + (to[2] - from[2]) * fraction,
  ];
}

function smokeAt(
  x: number,
  y: number,
  width: number,
  height: number,
  time: number,
  pointer: { x: number; y: number } | null,
) {
  const u = ((x / width) * 2 - 1) * Math.max(0.8, width / height);
  const v = (y / height) * 2 - 1;
  const drift = time * 0.16; // shaderSource.speed = 40

  // Domain-warped value noise makes soft, irregular smoke rather than a pair
  // of mathematically smooth waves. Warp/detail follow the supplied recipe.
  const warpX = fbm(u * 1.45 + drift * 0.7, v * 1.45 - drift * 0.45);
  const warpY = fbm(u * 1.45 - 13 - drift * 0.35, v * 1.45 + 8 + drift * 0.55);
  const smokeX = u + (warpX - 0.5) * 0.75; // shaderSource.warp = 37
  const smokeY = v + (warpY - 0.5) * 0.75;
  const body = fbm(smokeX * 1.65 + drift * 0.33, smokeY * 1.65 - drift * 0.2);
  const detail = fbm(smokeX * 4.8 - drift * 0.6, smokeY * 4.8 + drift * 0.39);
  const filament = Math.sin(smokeX * 11 + smokeY * 5 + (detail - 0.5) * 5);
  const center = smokeY + 0.06 - 0.24 * Math.sin(smokeX * 1.8 + time * 0.15);
  const veil = Math.exp(-((center / 0.65) ** 2));
  const cloud = Math.pow(
    clamp((body - 0.49) * 4.8 + (detail - 0.5) * 1.05 + filament * 0.055 + veil * 0.07),
    1.35,
  );

  // animStyle = shimmer, animSpeed = 100, animIntensity = 60. The very fine
  // stable grain stands in for shaderSource.grain = 12 before ASCII sampling.
  const shimmer = 0.5 + 0.5 * Math.sin(smokeX * 10.2 - smokeY * 4.1 - time * 1.2);
  let strength = cloud * (0.87 + shimmer * 0.13);
  strength += (hash(Math.floor(x * 0.65), Math.floor(y * 0.65)) - 0.5) * 0.07;

  if (pointer) {
    // shaderSource.mouseReactive spotlight, cursorStrength 65, cursorRadius 50.
    const dx = x / width - pointer.x;
    const dy = y / height - pointer.y;
    const radius = 0.28;
    const spotlight = Math.exp(-(dx * dx + dy * dy) / (radius * radius));
    strength += spotlight * 0.23;
  }

  return paletteColor(clamp(strength));
}

/** Animated Canvas2D smoke sampled into an 8px monochrome ASCII hatch grid. */
export default function ThreadLightCanvas({ className }: ThreadLightCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const output = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !output) return;

    const source = document.createElement("canvas");
    const sourceContext = source.getContext("2d", { willReadFrequently: true });
    const procedural = document.createElement("canvas");
    const proceduralContext = procedural.getContext("2d", { willReadFrequently: true });
    const sampled = document.createElement("canvas");
    const sampledContext = sampled.getContext("2d", { willReadFrequently: true });
    if (!sourceContext || !proceduralContext || !sampledContext) return;

    let width = 1;
    let height = 1;
    let columns = 1;
    let rows = 1;
    let pointer: { x: number; y: number } | null = null;
    let frame = 0;
    let lastFrame = -Infinity;
    let startTime = performance.now();
    let reducedMotion = false;
    let isVisible = true;
    let needsStillFrame = true;
    let proceduralImage = proceduralContext.createImageData(1, 1);
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    function resize() {
      if (!canvas || !output) return;
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(bounds.width));
      height = Math.max(1, Math.round(bounds.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      output.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);

      columns = Math.ceil(width / CELL_SIZE);
      rows = Math.ceil(height / CELL_SIZE);
      procedural.width = columns * 2;
      procedural.height = rows * 2;
      proceduralImage = proceduralContext!.createImageData(procedural.width, procedural.height);
      source.width = width;
      source.height = height;
      sampled.width = columns * 2;
      sampled.height = rows * 2;
      needsStillFrame = true;
    }

    function draw(now: number) {
      if (!output || !sourceContext || !proceduralContext || !sampledContext) return;
      frame = window.requestAnimationFrame(draw);
      if (document.hidden || !isVisible || (reducedMotion && !needsStillFrame)) return;
      if (!reducedMotion && now - lastFrame < 1000 / 24) return;
      lastFrame = now;
      needsStillFrame = false;
      const time = reducedMotion ? 0 : (now - startTime) / 1000;

      // 1. Render the supplied procedural smoke palette into an offscreen source
      // canvas at the target size. Its quarter-size raster keeps animation cheap.
      const pixels = proceduralImage.data;
      const rasterWidth = procedural.width;
      const rasterHeight = procedural.height;
      for (let y = 0; y < rasterHeight; y++) {
        for (let x = 0; x < rasterWidth; x++) {
          const [r, g, b] = smokeAt(
            (x + 0.5) * (width / rasterWidth),
            (y + 0.5) * (height / rasterHeight),
            width,
            height,
            time,
            pointer,
          );
          const index = (y * rasterWidth + x) * 4;
          pixels[index] = r;
          pixels[index + 1] = g;
          pixels[index + 2] = b;
          pixels[index + 3] = 255;
        }
      }
      proceduralContext.putImageData(proceduralImage, 0, 0);
      sourceContext.clearRect(0, 0, width, height);
      sourceContext.imageSmoothingEnabled = true;
      sourceContext.drawImage(procedural, 0, 0, width, height);

      // 2. Average four sub-cell samples per 8px hatch cell.
      sampledContext.clearRect(0, 0, sampled.width, sampled.height);
      sampledContext.drawImage(source, 0, 0, sampled.width, sampled.height);
      const samples = sampledContext.getImageData(0, 0, sampled.width, sampled.height).data;
      const paths = Array.from({ length: 7 }, () => new Path2D());
      const dots = new Path2D();

      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          let red = 0;
          let green = 0;
          let blue = 0;
          for (let sy = 0; sy < 2; sy++) {
            for (let sx = 0; sx < 2; sx++) {
              const index = ((row * 2 + sy) * sampled.width + column * 2 + sx) * 4;
              red += samples[index];
              green += samples[index + 1];
              blue += samples[index + 2];
            }
          }

          // 4. brightness 0, contrast 150%, saturation 0, grayscale 100%.
          // tintOpacity 0 and blurType off leave the sampled tone unchanged.
          const sourceLuminance =
            (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 4;
          const luminance = clamp(((sourceLuminance - 128) * 1.5 + 128) / 255);
          // 5. halftone at 30% also gently breaks up tone boundaries.
          const orderedOffset = (BAYER_4[row % 4][column % 4] / 16 - 0.5) * 0.09;
          const cellGrain = hash(column, row) - 0.5;
          const level = Math.min(
            6,
            Math.floor(clamp(luminance + orderedOffset + cellGrain * 0.12) * 7),
          );
          if (level === 0) continue;

          const path = paths[level];
          const left = column * CELL_SIZE;
          const top = row * CELL_SIZE;
          const jitterX = (hash(column + 31, row + 73) - 0.5) * 1.2;
          const jitterY = (hash(column + 94, row - 17) - 0.5) * 1.2;
          // 3. Hatch primitives add parallel and crossing strokes with light.
          if (level === 1) {
            path.moveTo(left + 3 + jitterX, top + 6 + jitterY);
            path.lineTo(left + 5 + jitterX, top + 4 + jitterY);
          } else {
            path.moveTo(left + 1 + jitterX, top + 7 + jitterY);
            path.lineTo(left + 7 + jitterX, top + 1 + jitterY);
          }
          if (level >= 3) {
            path.moveTo(left + 1 + jitterX, top + 3 + jitterY);
            path.lineTo(left + 3 + jitterX, top + 1 + jitterY);
            path.moveTo(left + 5 + jitterX, top + 7 + jitterY);
            path.lineTo(left + 7 + jitterX, top + 5 + jitterY);
          }
          if (level === 6 || (level === 5 && cellGrain > -0.25)) {
            path.moveTo(left + 1 + jitterX, top + 1 + jitterY);
            path.lineTo(left + 7 + jitterX, top + 7 + jitterY);
          }
          if (level >= 6) {
            path.moveTo(left + 1 + jitterX, top + 5 + jitterY);
            path.lineTo(left + 3 + jitterX, top + 7 + jitterY);
            path.moveTo(left + 5 + jitterX, top + 1 + jitterY);
            path.lineTo(left + 7 + jitterX, top + 3 + jitterY);
          }

          // 5. Enabled halftone post-effect at intensity 30.
          if (level >= 4 && luminance > BAYER_4[row % 4][column % 4] / 16) {
            dots.moveTo(left + 4.55, top + 4);
            dots.arc(left + 4, top + 4, 0.55, 0, Math.PI * 2);
          }
        }
      }

      output.fillStyle = "#030705";
      output.fillRect(0, 0, width, height);
      output.lineCap = "round";
      for (let level = 1; level <= 6; level++) {
        output.lineWidth = 0.8 + level * 0.07;
        output.strokeStyle = `rgba(242, 242, 238, ${0.13 + level * 0.13})`;
        output.stroke(paths[level]);
      }
      output.fillStyle = "rgba(245, 245, 240, 0.3)";
      output.fill(dots);
    }

    function onPointerMove(event: PointerEvent) {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      pointer = {
        x: clamp((event.clientX - rect.left) / rect.width),
        y: clamp((event.clientY - rect.top) / rect.height),
      };
      needsStillFrame = true;
    }

    function onPointerLeave() {
      pointer = null;
      needsStillFrame = true;
    }

    function onMotionChange() {
      reducedMotion = motionQuery.matches;
      startTime = performance.now();
      needsStillFrame = true;
    }

    reducedMotion = motionQuery.matches;
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      isVisible = entry.isIntersecting;
      if (isVisible) needsStillFrame = true;
    });
    intersectionObserver.observe(canvas);
    resize();
    frame = window.requestAnimationFrame(draw);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    motionQuery.addEventListener("change", onMotionChange);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      intersectionObserver.disconnect();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      motionQuery.removeEventListener("change", onMotionChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      style={{ display: "block", width: "100%", height: "100%" }}
    />
  );
}
