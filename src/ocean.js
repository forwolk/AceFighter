import * as THREE from 'three';

// Open-ocean surface seen from low altitude.
//  - Geometry: a few gentle Gerstner swells (real seas look nearly flat from 50 m up; the swell is
//    there for the wave-skimming moments).
//  - Normals: two Phillips/Tessendorf-spectrum cascades baked offline (320 m and 48 m patches),
//    wind-aligned and scrolled downwind, plus a rotated copy of the large cascade to kill tiling.
//  - Lighting: Schlick Fresnel against the sky panorama (blurrier with distance), a GGX microfacet
//    sun term whose roughness grows with distance (that is what makes the broad soft sun band
//    instead of pinpoint sparkle), a desaturated navy body colour, mild subsurface in sunlit crests,
//    spectrum-driven foam only in storm seas.
// World convention matches main.js: player at z = 0, sea streams toward +z; wz = z - dist.

const VERT = /* glsl */`
  uniform float uTime, uDist, uAmp;
  varying vec3 vWorld;
  varying vec2 vP;
  varying vec3 vGN;
  varying float vCrest;
  #include <fog_pars_vertex>
  const int NW = 4;
  const vec4 WAVES[NW] = vec4[NW](
    vec4( 0.80,  0.60, 150.0, 0.55),
    vec4( 0.55,  0.83,  92.0, 0.35),
    vec4(-0.35,  0.94,  51.0, 0.18),
    vec4( 0.96, -0.28,  27.0, 0.09)
  );
  void main() {
    vec3 p = position;
    vec2 q = vec2(p.x, p.z - uDist);
    vec3 disp = vec3(0.0); vec3 n = vec3(0.0, 1.0, 0.0); float h = 0.0;
    for (int i = 0; i < NW; i++) {
      vec2 D = normalize(WAVES[i].xy);
      float k = 6.2831853 / WAVES[i].z;
      float A = WAVES[i].w * uAmp;
      float c = sqrt(9.8 / k);
      float f = k * (dot(D, q) - c * uTime);
      float Q = min(0.5 / (k * A * float(NW) + 1e-4), 1.0);
      disp.x += Q * A * D.x * cos(f); disp.z += Q * A * D.y * cos(f); disp.y += A * sin(f);
      n.x -= D.x * k * A * cos(f); n.z -= D.y * k * A * cos(f); n.y -= Q * k * A * sin(f);
      h += A * sin(f);
    }
    vGN = normalize(n);
    vCrest = clamp(h / (1.2 * uAmp + 1e-4) * 0.5 + 0.5, 0.0, 1.0);
    vec3 world = p + disp;
    vWorld = (modelMatrix * vec4(world, 1.0)).xyz;
    vP = vec2(vWorld.x, vWorld.z - uDist);
    vec4 mvPosition = viewMatrix * vec4(vWorld, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */`
  uniform sampler2D uN0, uN1, uFoam, uSky;
  uniform mat3 uSkyRot;
  uniform vec3 uSunDir, uSunColor, uDeep, uShallow, uSkyTint;
  uniform vec2 uWind;
  uniform float uTime, uFoamAmt, uSunStrength, uSkyMix, uRoughBase, uFresMul, uDetailMul;
  varying vec3 vWorld; varying vec2 vP; varying vec3 vGN; varying float vCrest;
  #include <fog_pars_fragment>
  const float PI = 3.14159265;
  // baked as (x, up, along) -> use directly; only .x and .z perturb the normal (a previous swizzle added the
  // up component to z, tilting every pixel identically and cancelling the wave texture)
  vec3 nrm(sampler2D s, vec2 uv) { return texture2D(s, uv).xyz * 2.0 - 1.0; }
  vec2 equirect(vec3 d) { return vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5); }
  float ggx(float NdH, float a) { float a2 = a * a; float d = NdH * NdH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }

  void main() {
    vec3 toEye = cameraPosition - vWorld;
    float dist = length(toEye);
    vec3 V = toEye / dist;
    vec2 wind = uWind * uTime;
    // spectrum cascades: 320 m swell+sea (two copies, one rotated) and 48 m chop
    mat2 rot = mat2(0.866, 0.5, -0.5, 0.866);
    vec3 nA = nrm(uN0, (vP + wind * 0.9) / 320.0);
    vec3 nB = nrm(uN0, (rot * vP + wind * 0.7) / 247.0 + vec2(0.37, 0.61));
    vec3 nC = nrm(uN1, (vP + wind * 1.8) / 48.0);
    float chop = 1.0 - smoothstep(200.0, 1600.0, dist);           // unresolved chop becomes roughness instead
    vec3 detail = ((nA + nB) * 0.3 + nC * chop * 0.8) * uDetailMul;
    vec3 N = normalize(vec3(vGN.x + detail.x, 1.0, vGN.z + detail.z));
    float NdV = max(dot(N, V), 1e-3);

    // Fresnel + sky reflection (blurrier with distance)
    float F = clamp((0.04 + 0.96 * pow(1.0 - NdV, 5.0)) * uFresMul, 0.0, 0.8);   // real seas from low altitude are mostly sky
    vec3 R = reflect(-V, N); R.y = max(R.y, 0.02);
    float lod = 1.0 + smoothstep(300.0, 4000.0, dist) * 3.0;
    vec3 sky = textureLod(uSky, equirect(uSkyRot * R), lod).rgb * uSkyTint;

    // body: desaturated navy, slightly lighter where the sun hits, a hint of green-blue subsurface in crests
    float NdL = max(dot(N, uSunDir), 0.0);
    float sunBack = pow(max(dot(V, -vec3(uSunDir.x, 0.0, uSunDir.z)), 0.0), 2.0);
    float sss = smoothstep(0.55, 1.0, vCrest) * (0.3 + 0.7 * sunBack) * max(uSunDir.y, 0.1);
    vec3 body = uDeep * (0.65 + 0.35 * NdL) + uShallow * sss * 0.35;
    vec3 col = mix(body, sky, F * uSkyMix);

    // sun: GGX band whose roughness grows with distance (broad soft glitter path, not sparkle)
    vec3 H = normalize(V + uSunDir);
    float rough = clamp(uRoughBase + smoothstep(0.0, 5000.0, dist) * 0.22, 0.05, 0.45);
    float a = rough * rough;
    float D = ggx(max(dot(N, H), 0.0), a);
    float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
    float spec = D * Fs / (4.0 * NdV * max(NdL, 1e-3) + 0.05) * NdL;
    spec = spec / (1.0 + spec * 0.2);   // soft-limit the glitter: a low sun must not blow the whole near sea to white
    col += uSunColor * spec * uSunStrength * 0.9;

    // storm foam from the spectrum crests
    if (uFoamAmt > 0.001) {
      float foamTex = texture2D(uFoam, (vP + wind * 0.5) / 73.0).r;
      float foam = smoothstep(0.55, 0.95, vCrest + (foamTex - 0.5) * 0.4) * smoothstep(0.4, 0.85, foamTex) * uFoamAmt * (1.0 - smoothstep(300.0, 1500.0, dist));
      col = mix(col, vec3(0.8, 0.84, 0.86), clamp(foam, 0.0, 0.85));
    }

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createOcean({ n0, n1, foamMap, size = 9000, segments = 200 }) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -size / 2 + 600);
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 }, uDist: { value: 0 }, uAmp: { value: 1 },
    uN0: { value: null }, uN1: { value: null }, uFoam: { value: null }, uSky: { value: null },
    uSkyRot: { value: new THREE.Matrix3() },
    uSunDir: { value: new THREE.Vector3(0, 0.5, -1).normalize() }, uSunColor: { value: new THREE.Color(1, 1, 1) },
    uDeep: { value: new THREE.Color('#86a6c4') }, uShallow: { value: new THREE.Color('#2a8a90') },
    uSkyTint: { value: new THREE.Color(1, 1, 1) }, uSkyMix: { value: 1 }, uWind: { value: new THREE.Vector2(0.9, 3.0) },
    uFoamAmt: { value: 0 }, uSunStrength: { value: 1 }, uRoughBase: { value: 0.09 }, uFresMul: { value: 4.0 }, uDetailMul: { value: 1 },
  }]);
  uniforms.uN0.value = n0; uniforms.uN1.value = n1; uniforms.uFoam.value = foamMap;
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, fog: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return {
    mesh, uniforms,
    setSky(skyTex, yaw) {
      uniforms.uSky.value = skyTex;
      uniforms.uSkyRot.value.setFromMatrix4(new THREE.Matrix4().makeRotationY(-yaw));
    },
    update(dt, dist) { uniforms.uTime.value += dt; uniforms.uDist.value = dist; },
  };
}
