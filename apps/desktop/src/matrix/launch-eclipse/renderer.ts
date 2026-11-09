import { type EclipseFrame, MARK } from './engine'

/**
 * One fragment shader draws the eclipse over the launch's night (`.atum-launch-nun`, which
 * lifts on its own). The mark's geometry is exact; light is added on top and fades away, so
 * the last frame is the brand mark in its round face.
 */
const VERT = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }'

const FRAG = `
precision highp float;
uniform vec2 uCenter; uniform float uR; uniform float uTime;
uniform vec2 uMoon; uniform float uMoonR; uniform float uSun; uniform float uCorona; uniform float uCool;
uniform vec2 uBead; uniform float uBeadGlow; uniform float uBeadDisc; uniform float uFlash;
uniform float uFace; uniform vec4 uBaily[5];
const vec3 SUN = vec3(0.937, 0.933, 0.918);
const vec3 MOON = vec3(0.078, 0.075, 0.067);
const vec3 NIGHT = vec3(0.043, 0.039, 0.035);
const vec2 MARK_BEAD = vec2(${MARK.bead[0].toFixed(5)}, ${MARK.bead[1].toFixed(5)});
const float BEAD_R = ${MARK.beadR.toFixed(5)};
const float FACE_R = ${MARK.face.toFixed(5)};

float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float hash2(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float vnoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }

void main(){
  vec2 frag = gl_FragCoord.xy;
  vec2 p = (frag - uCenter) / uR;
  float r = length(p);
  float aa = 1.2 / uR;
  // Far from the eclipse nothing is drawn: most of the window costs nothing.
  if (r > 5.5 && uFace < 0.001) { gl_FragColor = vec4(0.0); return; }
  vec3 col = vec3(0.0);
  float alpha = 0.0;

  // The round face the mark lands in.
  float face = (1.0 - smoothstep(FACE_R - aa, FACE_R + aa, r)) * uFace;
  col = mix(col, MOON, face); alpha = max(alpha, face);

  float sunD = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
  float moonD = 1.0 - smoothstep(uMoonR - aa, uMoonR + aa, length(p - uMoon));

  // Corona: streamers stretched along the radius, finer filaments, a tilted axis, a slow drift.
  vec2 dir = p / max(r, 1e-4);
  float rr = max(r - 1.0, 0.0);
  float n1 = fbm(vec3(dir * 2.1, rr * 0.32 - uTime * 0.011));
  float n2 = fbm(vec3(dir * 6.6 + 4.0, rr * 0.85 - uTime * 0.019));
  float streak = 0.58 * n1 + 0.42 * n2;
  float axis = 0.72 + 0.4 * abs(dot(dir, normalize(vec2(0.92, 0.39))));
  float fall = exp(-rr * (2.9 - 0.7 * streak));
  float inner = exp(-rr * 15.0);
  float cor = (fall * axis * (0.16 + 1.25 * pow(streak, 2.4)) + inner * 0.85) * smoothstep(0.985, 1.03, r);
  vec3 coronaCol = mix(vec3(0.97, 0.945, 0.905), vec3(0.78, 0.82, 0.9), uCool);
  float covered = max(sunD * uSun, moonD);
  vec3 glow = coronaCol * cor * uCorona * (1.0 - covered) * mix(1.0, 0.55, uCool);

  // The sun's own light past its edge while it is uncovered (the approach direction).
  float exposed = uSun * (1.0 - smoothstep(0.0, 1.0, (uMoonR - length(uMoon) - 0.2) * 1.6 + 0.2));
  glow += SUN * 0.22 * exposed * exp(-rr * 6.0) * step(1.0, r);

  // The moon is always in front: the sun shows only where it is not.
  float sunVis = sunD * (1.0 - moonD) * uSun;
  col = mix(col, SUN, sunVis); alpha = max(alpha, sunVis);
  // The moon has no light of its own: it shows only against the sun and its corona.
  float moonVis = moonD * max(uSun * (1.0 - smoothstep(1.02, 1.32, r)), uFace);
  // In totality the moon is the night itself (the launch's night, #0b0a09); it becomes the mark's
  // moon colour only as the mark's round face forms around it.
  col = mix(col, mix(NIGHT, MOON, uFace), moonVis); alpha = max(alpha, moonVis);

  float beadD = (1.0 - smoothstep(BEAD_R - aa, BEAD_R + aa, length(p - MARK_BEAD))) * uBeadDisc * uSun;
  col = mix(col, SUN, beadD); alpha = max(alpha, beadD);

  for (int i = 0; i < 5; i++){
    vec2 q = p - uBaily[i].xy; float d2 = dot(q, q);
    glow += SUN * uBaily[i].z * (exp(-d2 / 0.0022) * 1.5 + 0.26 * exp(-d2 / 0.026));
  }

  // The diamond ring: a hot core, a soft bloom, a faint lens streak, and the flash.
  vec2 q = p - uBead; float d = length(q);
  float core = exp(-d * d / 0.0019);
  float bloom = 0.05 / (0.05 + d * d * 30.0);
  float streakH = exp(-abs(q.y) * 70.0) * exp(-abs(q.x) * 1.9);
  float streakV = exp(-abs(q.x) * 120.0) * exp(-abs(q.y) * 4.5) * 0.35;
  glow += SUN * uBeadGlow * (core * 1.6 + bloom * 0.8 + (streakH + streakV) * 0.32) * (1.0 + uFlash * 1.8);
  glow += vec3(1.0, 0.985, 0.95) * uFlash * (0.6 * exp(-d * 1.6) + 0.01) * (1.0 - 0.85 * moonD);

  // Light saturates like film rather than clipping; dither keeps the dark gradients smooth.
  vec3 g = vec3(1.0) - exp(-glow * 1.25);
  col = col + g * (1.0 - col * 0.6);
  alpha = clamp(alpha + max(g.r, max(g.g, g.b)), 0.0, 1.0);
  col += (hash2(frag + fract(uTime) * 61.0) - 0.5) / 255.0 * alpha;
  gl_FragColor = vec4(col, alpha);
}`

const UNIFORMS = [
  'uCenter',
  'uR',
  'uTime',
  'uMoon',
  'uMoonR',
  'uSun',
  'uCorona',
  'uCool',
  'uBead',
  'uBeadGlow',
  'uBeadDisc',
  'uFlash',
  'uFace',
  'uBaily'
] as const

export interface EclipseRenderer {
  draw(frame: EclipseFrame): void
  resize(width: number, height: number, ratio: number): void
  dispose(): void
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)

  if (!shader) {
    return null
  }

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null
}

/** The renderer, or null where WebGL is missing or refuses the shader (the CSS hero stands in). */
export function createEclipseRenderer(canvas: HTMLCanvasElement): EclipseRenderer | null {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: true })

  if (!gl) {
    return null
  }

  const vert = compile(gl, gl.VERTEX_SHADER, VERT)
  const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG)
  const program = gl.createProgram()

  if (!vert || !frag || !program) {
    return null
  }

  gl.attachShader(program, vert)
  gl.attachShader(program, frag)
  gl.linkProgram(program)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return null
  }

  gl.useProgram(program)
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'a')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

  const at = Object.fromEntries(UNIFORMS.map(name => [name, gl.getUniformLocation(program, name)])) as Record<
    (typeof UNIFORMS)[number],
    WebGLUniformLocation | null
  >

  const baily = new Float32Array(20)
  let ratio = 1
  let height = 0

  return {
    resize(cssWidth, cssHeight, pixelRatio) {
      ratio = pixelRatio
      height = cssHeight
      canvas.width = Math.round(cssWidth * pixelRatio)
      canvas.height = Math.round(cssHeight * pixelRatio)
      gl.viewport(0, 0, canvas.width, canvas.height)
    },
    draw(frame) {
      gl.uniform2f(at.uCenter, frame.center.x * ratio, (height - frame.center.y) * ratio)
      gl.uniform1f(at.uR, frame.r * ratio)
      gl.uniform1f(at.uTime, frame.time)
      gl.uniform2f(at.uMoon, frame.moon[0], frame.moon[1])
      gl.uniform1f(at.uMoonR, frame.moonR)
      gl.uniform1f(at.uSun, frame.sun)
      gl.uniform1f(at.uCorona, frame.corona)
      gl.uniform1f(at.uCool, frame.cool)
      gl.uniform2f(at.uBead, frame.bead[0], frame.bead[1])
      gl.uniform1f(at.uBeadGlow, frame.beadGlow)
      gl.uniform1f(at.uBeadDisc, frame.beadDisc)
      gl.uniform1f(at.uFlash, frame.flash)
      gl.uniform1f(at.uFace, frame.face)
      frame.baily.forEach(([x, y, s], i) => baily.set([x, y, s, 0], i * 4))
      gl.uniform4fv(at.uBaily, baily)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    // The context goes with its canvas. Losing it on purpose would leave a remount (React's
    // development double mount) with a dead context on the same canvas.
    dispose() {
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
    }
  }
}

let support: boolean | undefined

/** Whether this window can draw the eclipse (asked once; jsdom and blocklisted GPUs cannot). */
export function launchEclipseSupported() {
  if (support === undefined) {
    try {
      const probe = document.createElement('canvas')
      support = Boolean(probe.getContext?.('webgl'))
      probe.getContext('webgl')?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      support = false
    }
  }

  return support
}
