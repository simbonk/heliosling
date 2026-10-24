import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

const MAX_HOLES = 4;

// Screen-space gravitational lensing: every on-screen black hole bends the image behind it
// (a point-lens deflection) and lights up an Einstein ring.
export function makeLensPass() {
  const pass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      holes: { value: Array.from({ length: MAX_HOLES }, () => new THREE.Vector3()) },
      count: { value: 0 },
      aspect: { value: 1 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform vec3 holes[${MAX_HOLES}]; uniform int count; uniform float aspect;
      varying vec2 vUv;
      void main(){
        vec2 uv = vUv; float ring = 0.0; float shadow = 1.0;
        for (int i = 0; i < ${MAX_HOLES}; i++) {
          if (i >= count) break;
          vec2 c = holes[i].xy; float re = holes[i].z;
          vec2 d = uv - c; d.x *= aspect;
          float r = length(d);
          if (r < 1e-5) continue;
          // thin-lens deflection: images pushed outward by re^2 / r
          float defl = re * re / r;
          vec2 dir = d / r;
          vec2 src = d - dir * defl;
          src.x /= aspect;
          float w = smoothstep(re * 6.0, re * 2.0, r);
          uv = mix(uv, c + src, w);
          ring += exp(-pow((r - re) / (re * 0.12), 2.0)) * 0.9;
          shadow *= smoothstep(re * 0.55, re * 0.75, r);
        }
        vec3 col = texture2D(tDiffuse, uv).rgb * shadow;
        col += vec3(1.0, 0.78, 0.5) * ring;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  pass.update = (holes, camera, sim, toRender, size) => {
    const list = [];
    const v = new THREE.Vector3(), edge = new THREE.Vector3(), right = new THREE.Vector3();
    for (const b of holes) {
      toRender(b, v);
      const dist = camera.position.distanceTo(v);
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      edge.copy(v).addScaledVector(right, sim.radius(b) * 2.6);
      const p = v.clone().project(camera);
      if (p.z > 1 || Math.abs(p.x) > 1.6 || Math.abs(p.y) > 1.6 || dist <= 0) continue;
      const e = edge.project(camera);
      const re = Math.abs(e.x - p.x) / 2 * (size.w / size.h);
      if (re < 0.002) continue;
      list.push(new THREE.Vector3((p.x + 1) / 2, (p.y + 1) / 2, Math.min(re, 0.25)));
      if (list.length === MAX_HOLES) break;
    }
    pass.uniforms.count.value = list.length;
    list.forEach((h, i) => pass.uniforms.holes.value[i].copy(h));
    pass.uniforms.aspect.value = size.w / size.h;
    pass.enabled = list.length > 0;
  };
  pass.enabled = false;
  return pass;
}

// Earth: day map lit by the nearest star, city lights on the night side, blue Fresnel rim.
export function makeEarthMaterial(day, night) {
  return new THREE.ShaderMaterial({
    uniforms: { dayMap: { value: day }, nightMap: { value: night }, sunPos: { value: new THREE.Vector3() }, sunPower: { value: 1 } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv; varying vec3 vNormal; varying vec3 vWorld;
      void main(){
        vUv = uv;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D dayMap; uniform sampler2D nightMap; uniform vec3 sunPos; uniform float sunPower;
      varying vec2 vUv; varying vec3 vNormal; varying vec3 vWorld;
      void main(){
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vNormal);
        vec3 l = normalize(sunPos - vWorld);
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float ndl = dot(n, l);
        float day = smoothstep(-0.15, 0.25, ndl) * sunPower;
        vec3 dayCol = texture2D(dayMap, vUv).rgb;
        vec3 nightCol = texture2D(nightMap, vUv).rgb * vec3(1.0, 0.75, 0.4) * 1.6;
        vec3 col = dayCol * (0.03 + max(ndl, 0.0) * 1.1 * sunPower) + nightCol * (1.0 - day);
        float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
        col += vec3(0.3, 0.6, 1.0) * fres * (0.15 + 0.85 * smoothstep(-0.3, 0.4, ndl) * sunPower);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// "Rubber sheet" spacetime grid: lines sag into funnels under every mass.
const MAX_WELLS = 24;
export function makeGravityGrid() {
  const lines = 90, seg = 220, size = 2;
  const pts = [];
  for (let i = 0; i <= lines; i++) {
    const u = -1 + (2 * i) / lines;
    for (let j = 0; j < seg; j++) {
      const a = -1 + (2 * j) / seg, b = -1 + (2 * (j + 1)) / seg;
      pts.push(u, 0, a, u, 0, b);
      pts.push(a, 0, u, b, 0, u);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts.map((v) => v * size / 2), 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { wells: { value: Array.from({ length: MAX_WELLS }, () => new THREE.Vector4()) }, count: { value: 0 }, scale: { value: 40 }, depth: { value: 1 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform vec4 wells[${MAX_WELLS}]; uniform int count; uniform float scale; uniform float depth;
      varying float vSag; varying float vEdge;
      void main(){
        vec3 p = position * scale;
        float sag = 0.0;
        for (int i = 0; i < ${MAX_WELLS}; i++) {
          if (i >= count) break;
          vec2 d = p.xz - wells[i].xz;
          float w = wells[i].y;
          sag += wells[i].w * w / sqrt(dot(d, d) + w * w);
        }
        p.y -= sag * depth;
        vSag = sag; vEdge = length(position.xz);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float scale;
      varying float vSag; varying float vEdge;
      void main(){
        #include <logdepthbuf_fragment>
        float fade = 1.0 - smoothstep(0.55, 1.0, vEdge);
        vec3 c = mix(vec3(0.1, 0.45, 0.9), vec3(0.75, 0.35, 1.0), clamp(vSag / (scale * 0.3), 0.0, 1.0));
        gl_FragColor = vec4(c * fade * 0.55, fade);
      }`,
  });
  const mesh = new THREE.LineSegments(g, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.update = (bodies, toRender, center, scale) => {
    const wells = mat.uniforms.wells.value;
    const v = new THREE.Vector3();
    const heavy = bodies.filter((b) => b.alive && b.mass > 1e-9).sort((a, b) => b.mass - a.mass).slice(0, MAX_WELLS);
    heavy.forEach((b, i) => {
      toRender(b, v);
      const m = Math.pow(b.mass, 0.28);
      // x,z = position relative to grid centre, y = funnel width, w = funnel depth
      wells[i].set(v.x - center.x, scale * (0.004 + 0.02 * m), v.z - center.z, scale * 0.09 * m);
    });
    mat.uniforms.count.value = heavy.length;
    mat.uniforms.scale.value = scale;
    mesh.position.copy(center);
    mesh.position.y -= scale * 0.02;
  };
  return mesh;
}

export function logDepthDiskChunks(material) {
  material.vertexShader = material.vertexShader
    .replace('void main(){', '\n#include <common>\n#include <logdepthbuf_pars_vertex>\nvoid main(){')
    .replace(/gl_Position=([^;]+);\}/, 'gl_Position=$1;\n#include <logdepthbuf_vertex>\n}');
  material.fragmentShader = material.fragmentShader
    .replace('uniform float time;', '\n#include <common>\n#include <logdepthbuf_pars_fragment>\nuniform float time;')
    .replace('void main(){', 'void main(){\n#include <logdepthbuf_fragment>\n');
  return material;
}
