import * as THREE from 'three';

// Open-ocean surface: Gerstner swell + three scrolling normal-map layers, Fresnel reflection of the
// sky panorama, sharp sun glitter, subsurface colour in sunlit crests and crest foam.
// World convention matches main.js: the player sits at z = 0 and the sea scrolls toward +z, so every
// lookup uses the scrolled coordinate wz = z - dist.

const VERT = /* glsl */`
  uniform float uTime, uDist, uAmp;
  varying vec3 vWorld;      // un-scrolled world position (for view vector / fog)
  varying vec2 vP;          // scrolled horizontal coordinate (x, z - dist)
  varying vec3 vGN;         // Gerstner normal
  varying float vCrest;     // 0..1 wave height for foam / subsurface
  #include <fog_pars_vertex>

  const int NW = 4;
  // direction.xy, wavelength, amplitude
  const vec4 WAVES[NW] = vec4[NW](
    vec4( 0.80,  0.60, 95.0, 1.00),
    vec4(-0.35,  0.94, 57.0, 0.55),
    vec4( 0.96, -0.28, 33.0, 0.30),
    vec4( 0.20,  0.98, 19.0, 0.14)
  );

  void main() {
    vec3 p = position;
    vec2 q = vec2(p.x, p.z - uDist);
    vec3 disp = vec3(0.0);
    vec3 n = vec3(0.0, 1.0, 0.0);
    float h = 0.0;
    for (int i = 0; i < NW; i++) {
      vec2 D = normalize(WAVES[i].xy);
      float k = 6.2831853 / WAVES[i].z;
      float A = WAVES[i].w * uAmp;
      float c = sqrt(9.8 / k);
      float f = k * (dot(D, q) - c * uTime);
      float Q = 0.55 / (k * A * float(NW) + 1e-4);
      Q = min(Q, 1.0);
      disp.x += Q * A * D.x * cos(f);
      disp.z += Q * A * D.y * cos(f);
      disp.y += A * sin(f);
      n.x -= D.x * k * A * cos(f);
      n.z -= D.y * k * A * cos(f);
      n.y -= Q * k * A * sin(f);
      h += A * sin(f);
    }
    vGN = normalize(n);
    vCrest = clamp(h / (2.0 * uAmp + 1e-4) * 0.5 + 0.5, 0.0, 1.0);
    vec3 world = p + disp;
    vWorld = (modelMatrix * vec4(world, 1.0)).xyz;
    vP = vec2(vWorld.x, vWorld.z - uDist);
    vec4 mvPosition = viewMatrix * vec4(vWorld, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */`
  uniform sampler2D uNormal, uFoam, uSky;
  uniform mat3 uSkyRot;
  uniform vec3 uSunDir, uSunColor, uDeep, uShallow, uSkyTint;
  uniform float uTime, uFoamAmt, uSunStrength, uSkyMix;
  varying vec3 vWorld;
  varying vec2 vP;
  varying vec3 vGN;
  varying float vCrest;
  #include <fog_pars_fragment>

  vec3 nrm(vec2 uv) { vec3 t = texture2D(uNormal, uv).xyz * 2.0 - 1.0; return vec3(t.x, t.z, -t.y); }
  vec2 equirect(vec3 d) {
    return vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
  }

  void main() {
    vec3 toEye = cameraPosition - vWorld;
    float dist = length(toEye);
    vec3 V = toEye / dist;
    float t = uTime;
    // three normal layers: macro swell detail, mid chop, fine ripples (faded with distance)
    vec3 n1 = nrm(vP / 210.0 + vec2(t * 0.004, t * 0.007));
    vec3 n2 = nrm(vP / 47.0 + vec2(-t * 0.013, t * 0.018));
    vec3 n3 = nrm(vP / 13.0 + vec2(t * 0.031, -t * 0.024));
    float fine = 1.0 - smoothstep(150.0, 900.0, dist);
    vec3 detail = n1 * 0.9 + n2 * 0.8 + n3 * 0.55 * fine;
    vec3 N = normalize(vec3(vGN.x + detail.x * 0.55, vGN.y, vGN.z + detail.z * 0.55));
    // flatten toward the horizon to avoid noisy speckle at grazing angles
    N = normalize(mix(N, vec3(0.0, 1.0, 0.0), smoothstep(1200.0, 5000.0, dist) * 0.8));

    float NdV = max(dot(N, V), 0.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    // explicit LOD: automatic mip selection breaks at the equirect u-wrap and draws a seam line
    vec3 sky = textureLod(uSky, equirect(uSkyRot * R), 1.5).rgb * uSkyTint;

    // water body: deep colour + subsurface turquoise where sunlit crests face the viewer
    float sunBack = pow(max(dot(V, -vec3(uSunDir.x, 0.0, uSunDir.z)), 0.0), 2.0);
    float sss = smoothstep(0.45, 1.0, vCrest) * (0.35 + 0.65 * sunBack) * max(uSunDir.y, 0.15);
    vec3 body = uDeep * (0.55 + 0.45 * max(dot(N, uSunDir), 0.0)) + uShallow * sss * 0.9;

    vec3 col = mix(body, sky, fresnel * uSkyMix);

    // sun: sharp glitter + broad sheen
    float s = max(dot(R, uSunDir), 0.0);
    col += uSunColor * (pow(s, 900.0) * 14.0 + pow(s, 120.0) * 1.2 + pow(s, 12.0) * 0.06) * uSunStrength;

    // foam on crests (texture breaks it into lacy streaks), fades with distance
    float foamTex = texture2D(uFoam, vP / 34.0 + detail.xz * 0.05).r;
    float foam = smoothstep(0.62, 0.92, vCrest + foamTex * 0.35) * uFoamAmt * (1.0 - smoothstep(300.0, 1500.0, dist));
    col = mix(col, vec3(0.9, 0.94, 0.96) * (0.6 + 0.4 * max(uSunDir.y, 0.0)), clamp(foam * foamTex * 1.6, 0.0, 1.0));

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createOcean({ normalMap, foamMap, size = 9000, segments = 320 }) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -size / 2 + 600);
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 }, uDist: { value: 0 }, uAmp: { value: 1 },
    uNormal: { value: null }, uFoam: { value: null }, uSky: { value: null },
    uSkyRot: { value: new THREE.Matrix3() },
    uSunDir: { value: new THREE.Vector3(0, 0.5, -1).normalize() }, uSunColor: { value: new THREE.Color(1, 1, 1) },
    uDeep: { value: new THREE.Color('#06325e') }, uShallow: { value: new THREE.Color('#2bb3b8') },
    uSkyTint: { value: new THREE.Color(1, 1, 1) }, uSkyMix: { value: 1 },
    uFoamAmt: { value: 0.35 }, uSunStrength: { value: 1 },
  }]);
  uniforms.uNormal.value = normalMap;
  uniforms.uFoam.value = foamMap;
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, fog: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return {
    mesh,
    uniforms,
    // sky: equirect texture shown as scene.background; yaw: the backgroundRotation.y applied to it
    setSky(skyTex, yaw) {
      uniforms.uSky.value = skyTex;
      uniforms.uSkyRot.value.setFromMatrix4(new THREE.Matrix4().makeRotationY(-yaw));
    },
    update(dt, dist) {
      uniforms.uTime.value += dt;
      uniforms.uDist.value = dist;
    },
  };
}
