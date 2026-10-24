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
  const drift = time * 0.23; // shaderSource.speed = 40
  const turbulence = fbm(u * 1.1 + drift * 0.35, v * 1.1 - drift * 0.22);
  const fine = noise(u * 4.2 - drift * 0.2, v * 4.2 + drift * 0.16);
  const warp = (turbulence - 0.5) * 0.44 + (fine - 0.5) * 0.08; // warp = 37
  const warpedV = v + warp;

  // Two moving, irregular light threads wrapped in a softer smoke field.
  const centerA =
    -0.13 + 0.24 * Math.sin(u * 1.35 + drift * 0.7) + 0.07 * Math.sin(u * 3.4 - drift);
  const centerB =
    0.34 + 0.22 * Math.sin(u * 1.7 - drift * 0.52 + 1.8) +
    0.06 * Math.sin(u * 4.1 + drift * 0.6);
  const distanceA = (warpedV - centerA) / 0.24;
  const distanceB = (warpedV - centerB) / 0.19;
  const ribbonA = Math.exp(-distanceA * distanceA);
  const ribbonB = Math.exp(-distanceB * distanceB);
  const filaments = Math.pow(
    0.5 + 0.5 * Math.sin(u * 21 + warpedV * 8 + turbulence * 5 - drift * 2),
    11,
  );
  const ambient = Math.max(0, turbulence * 0.38 + fine * 0.12 - 0.12);
  const shimmer = 0.7 + 0.3 * Math.sin(u * 8.5 - v * 3.5 - time * 1.35);
  let strength =
    ambient +
    (ribbonA * 0.78 + ribbonB * 0.64) * (0.68 + shimmer * 0.32) +
    filaments * Math.max(ribbonA, ribbonB) * 0.29;

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
      if (document.hidden || (reducedMotion && !needsStillFrame)) return;
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
          red = clamp(((red / 4 - 128) * 1.5 + 128) / 255);
          green = clamp(((green / 4 - 128) * 1.5 + 128) / 255);
          blue = clamp(((blue / 4 - 128) * 1.5 + 128) / 255);
          const luminance = clamp(red * 0.2126 + green * 0.7152 + blue * 0.0722);
          const level = Math.min(6, Math.floor(luminance * 7));
          if (level === 0) continue;

          const path = paths[level];
          const left = column * CELL_SIZE;
          const top = row * CELL_SIZE;
          // 3. Hatch primitives use extra crossing strokes as light increases.
          path.moveTo(left + 1, top + 7);
          path.lineTo(left + 7, top + 1);
          if (level >= 3) {
            path.moveTo(left + 1, top + 1);
            path.lineTo(left + 7, top + 7);
          }
          if (level >= 5) {
            path.moveTo(left + 1, top + 3);
            path.lineTo(left + 3, top + 1);
            path.moveTo(left + 5, top + 7);
            path.lineTo(left + 7, top + 5);
          }

          // 5. Enabled halftone post-effect at intensity 30.
          if (level >= 4 && luminance > BAYER_4[row % 4][column % 4] / 16) {
            dots.moveTo(left + 4.55, top + 4);
            dots.arc(left + 4, top + 4, 0.55, 0, Math.PI * 2);
          }
        }
      }

      output.fillStyle = "#07120f";
      output.fillRect(0, 0, width, height);
      output.lineCap = "round";
      output.lineWidth = 0.8;
      for (let level = 1; level <= 6; level++) {
        output.strokeStyle = `rgba(242, 242, 238, ${0.12 + level * 0.125})`;
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
    resize();
    frame = window.requestAnimationFrame(draw);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    motionQuery.addEventListener("change", onMotionChange);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
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
