/* ══════════════════════════════════════════════════════════
   NEON DRIFT — Full Game Engine
   Three.js + MediaPipe Hands + Web Audio API + Custom Physics
══════════════════════════════════════════════════════════ */

// ── CDN Imports ──────────────────────────────────────────
const THREE_CDN   = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const MP_HANDS    = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/hands.js';
const MP_CAM      = 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1640029074/camera_utils.js';
const MP_DRAW     = 'https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils@0.3.1620248257/drawing_utils.js';

// ── Game State ────────────────────────────────────────────
const G = {
  vehicleType: 'car',
  running: false,
  nightMode: true,
  lap: 1, totalLaps: 3,
  startTime: 0, lapTime: 0,
  countdown: 3, countdownActive: false,
  finished: false
};

// ── Gesture State (smoothed) ──────────────────────────────
const GESTURE = {
  steer: 0,       // -1 to 1
  throttle: 0,    // 0 to 1
  brake: 0,       // 0 to 1
  nitro: false,
  // raw targets (pre-lerp)
  _steer: 0, _throttle: 0, _brake: 0, _nitro: false,
  handsDetected: false
};

// ── Vehicle Physics State ─────────────────────────────────
const CAR = {
  x: 0, z: 0,
  vx: 0, vz: 0,
  angle: 0,          // yaw radians
  speed: 0,          // m/s
  steerAngle: 0,     // current wheel steer
  rpm: 0,
  gear: 0,           // 0=N, 1-6=gears, -1=R
  nitro: 100,
  drifting: false,
  driftIntensity: 0,
  lean: 0,           // for bike leaning
  lapProgress: 0,    // 0-1 around track
  lastCheckpoint: -1,
  skidMarks: [],     // [{x,z,age}]
};

// ── Vehicle Configs ───────────────────────────────────────
const VEHICLE_CFG = {
  car: {
    maxSpeed: 42, accel: 18, brakeForce: 28,
    steerMax: 0.032, steerReturn: 0.1,
    grip: 0.88, driftThreshold: 26,
    mass: 1400, nitroMult: 1.7,
    gearRatios: [0, 3.4, 2.1, 1.5, 1.1, 0.85, 0.7]
  },
  bike: {
    maxSpeed: 55, accel: 24, brakeForce: 22,
    steerMax: 0.028, steerReturn: 0.08,
    grip: 0.64, driftThreshold: 18,
    mass: 680, nitroMult: 2.1,
    gearRatios: [0, 3.8, 2.4, 1.7, 1.2, 0.9, 0.72]
  }
};

// ── Track ─────────────────────────────────────────────────
const TRACK_RADIUS = 220;
const TRACK_WIDTH  = 28;

// Figure-8 / complex loop track points (world coords)
function buildTrackPoints() {
  const pts = [];
  const N = 128;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    // Lemniscate-inspired shape
    const scale = 180;
    const x = scale * Math.sin(t) / (1 + Math.cos(t) * Math.cos(t));
    const z = scale * Math.sin(t) * Math.cos(t) / (1 + Math.cos(t) * Math.cos(t));
    pts.push({ x, z });
  }
  return pts;
}
const TRACK_PTS = buildTrackPoints();

// ── Audio Engine ──────────────────────────────────────────
let audioCtx, engineOsc, engineGain, scrGain, bgGain, masterGain;
let engineStarted = false;

function initAudio() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain(); masterGain.gain.value = 0.8;
    masterGain.connect(audioCtx.destination);

    // Engine oscillator (sawtooth for engine growl)
    engineOsc = audioCtx.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = 60;
    const distortion = audioCtx.createWaveShaper();
    distortion.curve = makeDistortionCurve(120);
    engineOsc.connect(distortion);
    const loPass = audioCtx.createBiquadFilter();
    loPass.type = 'lowpass'; loPass.frequency.value = 600;
    distortion.connect(loPass);
    engineGain = audioCtx.createGain(); engineGain.gain.value = 0;
    loPass.connect(engineGain);
    engineGain.connect(masterGain);
    engineOsc.start();

    // Tire screech
    const scrBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.5, audioCtx.sampleRate);
    const scrData = scrBuffer.getChannelData(0);
    for (let i = 0; i < scrData.length; i++) scrData[i] = (Math.random() * 2 - 1) * 0.6;
    const scrSrc = audioCtx.createBufferSource();
    scrSrc.buffer = scrBuffer; scrSrc.loop = true;
    const scrFilter = audioCtx.createBiquadFilter();
    scrFilter.type = 'bandpass'; scrFilter.frequency.value = 1200; scrFilter.Q.value = 0.5;
    scrSrc.connect(scrFilter);
    scrGain = audioCtx.createGain(); scrGain.gain.value = 0;
    scrFilter.connect(scrGain);
    scrGain.connect(masterGain);
    scrSrc.start();

    // Ambient cyberpunk hum
    const bgOsc = audioCtx.createOscillator();
    bgOsc.type = 'sine'; bgOsc.frequency.value = 55;
    const bgOsc2 = audioCtx.createOscillator();
    bgOsc2.type = 'triangle'; bgOsc2.frequency.value = 82;
    bgGain = audioCtx.createGain(); bgGain.gain.value = 0.04;
    bgOsc.connect(bgGain); bgOsc2.connect(bgGain);
    bgGain.connect(masterGain);
    bgOsc.start(); bgOsc2.start();
    engineStarted = true;
  } catch(e) { console.warn('Audio init failed:', e); }
}

function makeDistortionCurve(amount) {
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i * 2 / 256 - 1;
    curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

function updateAudio(dt) {
  if (!engineStarted || !audioCtx) return;
  try {
    const rpmNorm = CAR.rpm / 100;
    const freq = 55 + rpmNorm * 280 + CAR.gear * 15;
    engineOsc.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.08);
    const vol = G.running ? (0.08 + rpmNorm * 0.18) : 0;
    engineGain.gain.setTargetAtTime(vol, audioCtx.currentTime, 0.1);
    const scrVol = CAR.drifting ? CAR.driftIntensity * 0.25 : 0;
    scrGain.gain.setTargetAtTime(scrVol, audioCtx.currentTime, 0.05);
  } catch(e) {}
}

// ════════════════════════════════════════════════════════════
// THREE.JS ENGINE
// ════════════════════════════════════════════════════════════
let scene, camera, renderer, clock;
let vehicleMesh, vehicleBody, wheelMeshes = [];
let skidMarkSystem, particleSystem, nitroParticles;
let sunLight, ambLight, neonLights = [];
let groundMesh, trackMesh, buildingGroup, fogVolumes = [];
let minimapRenderer, minimapCamera, minimapScene;
let bloomPass, composer;
let frameCount = 0;

async function initThree() {
  const THREE = await import(THREE_CDN);
  window._THREE = THREE;

  const canvas = document.getElementById('gameCanvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000814, 0.006);

  clock = new THREE.Clock();

  camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 5, 12);

  buildLights(THREE);
  buildGround(THREE);
  buildTrack(THREE);
  buildCity(THREE);
  buildVehicle(THREE);
  buildParticles(THREE);
  buildMinimap(THREE);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  window._THREE_READY = true;
}

function buildLights(THREE) {
  ambLight = new THREE.AmbientLight(0x030820, 1.2);
  scene.add(ambLight);

  sunLight = new THREE.DirectionalLight(0x6688cc, 0.4);
  sunLight.position.set(100, 200, 100);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 1000;
  sunLight.shadow.camera.left = sunLight.shadow.camera.bottom = -400;
  sunLight.shadow.camera.right = sunLight.shadow.camera.top = 400;
  scene.add(sunLight);

  // Neon point lights along track
  const neonColors = [0x00ffff, 0xff00ff, 0x0088ff, 0x00ff88];
  for (let i = 0; i < 12; i++) {
    const t = (i / 12) * Math.PI * 2;
    const pt = getTrackPos(t);
    const light = new THREE.PointLight(neonColors[i % 4], 3, 80);
    light.position.set(pt.x, 8, pt.z);
    scene.add(light);
    neonLights.push(light);
  }
}

function buildGround(THREE) {
  // Road texture procedural
  const texSize = 512;
  const texData = new Uint8Array(texSize * texSize * 4);
  for (let y = 0; y < texSize; y++) {
    for (let x = 0; x < texSize; x++) {
      const i = (y * texSize + x) * 4;
      const base = 18 + Math.random() * 8;
      texData[i] = base; texData[i+1] = base; texData[i+2] = base + 5; texData[i+3] = 255;
    }
  }
  const groundTex = new THREE.DataTexture(texData, texSize, texSize, THREE.RGBAFormat);
  groundTex.needsUpdate = true;
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
  groundTex.repeat.set(40, 40);

  groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.92, metalness: 0.1, color: 0x111122 })
  );
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);
}

function getTrackPos(t) {
  const scale = 180;
  const x = scale * Math.sin(t) / (1 + Math.cos(t) * Math.cos(t));
  const z = scale * Math.sin(t) * Math.cos(t) / (1 + Math.cos(t) * Math.cos(t));
  return { x, z };
}

function getTrackTangent(t) {
  const dt = 0.001;
  const p1 = getTrackPos(t - dt);
  const p2 = getTrackPos(t + dt);
  const dx = p2.x - p1.x, dz = p2.z - p1.z;
  const len = Math.sqrt(dx*dx + dz*dz);
  return { x: dx/len, z: dz/len };
}

function buildTrack(THREE) {
  const N = 256;
  const positions = [], indices = [], uvs = [], normals = [];

  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const pos = getTrackPos(t);
    const tang = getTrackTangent(t);
    const nx = -tang.z, nz = tang.x;

    for (let s = 0; s <= 1; s++) {
      const side = s === 0 ? -TRACK_WIDTH : TRACK_WIDTH;
      positions.push(pos.x + nx * side, 0.05, pos.z + nz * side);
      uvs.push(s, i / N * 12);
      normals.push(0, 1, 0);
    }
  }

  for (let i = 0; i < N; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, c, b, b, c, d);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);

  // Road texture with lane markings
  const roadCanvas = document.createElement('canvas');
  roadCanvas.width = 256; roadCanvas.height = 512;
  const rc = roadCanvas.getContext('2d');
  rc.fillStyle = '#141420';
  rc.fillRect(0, 0, 256, 512);
  // Lane marking
  rc.strokeStyle = '#00ffff44';
  rc.lineWidth = 6;
  rc.setLineDash([60, 40]);
  rc.beginPath(); rc.moveTo(128, 0); rc.lineTo(128, 512); rc.stroke();
  // Edge lines
  rc.strokeStyle = '#ff00ff66';
  rc.lineWidth = 4; rc.setLineDash([]);
  rc.beginPath(); rc.moveTo(8,0); rc.lineTo(8,512); rc.stroke();
  rc.beginPath(); rc.moveTo(248,0); rc.lineTo(248,512); rc.stroke();

  const roadTex = new THREE.CanvasTexture(roadCanvas);
  roadTex.wrapS = THREE.RepeatWrapping; roadTex.wrapT = THREE.RepeatWrapping;

  trackMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: roadTex, roughness: 0.8, metalness: 0.05, color: 0x223344,
    emissive: 0x001122, emissiveIntensity: 0.3
  }));
  trackMesh.receiveShadow = true;
  scene.add(trackMesh);

  // Glowing edge lines
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 2 });
  for (const side of [-1, 1]) {
    const edgePts = [];
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * Math.PI * 2;
      const pos = getTrackPos(t);
      const tang = getTrackTangent(t);
      const nx = -tang.z, nz = tang.x;
      edgePts.push(new THREE.Vector3(pos.x + nx * TRACK_WIDTH * side, 0.15, pos.z + nz * TRACK_WIDTH * side));
    }
    const edgeGeo = new THREE.BufferGeometry().setFromPoints(edgePts);
    scene.add(new THREE.Line(edgeGeo, new THREE.LineBasicMaterial({ color: side > 0 ? 0x00ffff : 0xff00ff })));
  }
}

function buildCity(THREE) {
  buildingGroup = new THREE.Group();
  scene.add(buildingGroup);

  const buildingColors = [0x002244, 0x110022, 0x001133, 0x220011, 0x001122];
  const emissiveColors = [0x0044ff, 0x440088, 0x004488, 0x880044, 0x008844];
  const windowColors   = [0x00ffff, 0xff00ff, 0x00ff88, 0xff4400, 0xffcc00];

  const rng = (a, b) => a + Math.random() * (b - a);

  for (let i = 0; i < 180; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = rng(90, 420);
    const bx = Math.cos(angle) * dist;
    const bz = Math.sin(angle) * dist;

    // Check not on track
    const tp = getClosestTrackT({ x: bx, z: bz });
    const closest = getTrackPos(tp);
    const dd = Math.sqrt((bx-closest.x)**2 + (bz-closest.z)**2);
    if (dd < TRACK_WIDTH * 2.2) continue;

    const w = rng(6, 22), d = rng(6, 22), h = rng(15, 120);
    const ci = Math.floor(Math.random() * buildingColors.length);

    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshStandardMaterial({
      color: buildingColors[ci],
      emissive: emissiveColors[ci],
      emissiveIntensity: 0.15,
      roughness: 0.6, metalness: 0.8
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(bx, h/2, bz);
    mesh.castShadow = true;
    buildingGroup.add(mesh);

    // Window grid emissive panels
    if (h > 30 && Math.random() > 0.4) {
      const wRows = Math.floor(h / 6), wCols = Math.floor(w / 4);
      for (let wr = 0; wr < wRows; wr++) {
        for (let wc = 0; wc < wCols; wc++) {
          if (Math.random() > 0.6) {
            const wGeo = new THREE.PlaneGeometry(1.2, 1.8);
            const wci = Math.floor(Math.random() * windowColors.length);
            const wMat = new THREE.MeshBasicMaterial({
              color: windowColors[wci],
              side: THREE.FrontSide
            });
            const wMesh = new THREE.Mesh(wGeo, wMat);
            const wx = (wc - wCols/2) * 4 + 2;
            const wy = wr * 6 - h/2 + 4;
            wMesh.position.set(bx + wx, wy + h/2, bz + d/2 + 0.1);
            buildingGroup.add(wMesh);
          }
        }
      }
    }

    // Rooftop light
    if (Math.random() > 0.6) {
      const roofLight = new THREE.PointLight(windowColors[Math.floor(Math.random()*windowColors.length)], 2, 60);
      roofLight.position.set(bx, h + 2, bz);
      scene.add(roofLight);
    }
  }

  // Streetlights along track
  for (let i = 0; i < 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    const pos = getTrackPos(t);
    const tang = getTrackTangent(t);
    for (const side of [-1, 1]) {
      const nx = -tang.z * side, nz = tang.x * side;
      const px = pos.x + nx * (TRACK_WIDTH + 4);
      const pz = pos.z + nz * (TRACK_WIDTH + 4);

      const poleGeo = new THREE.CylinderGeometry(0.12, 0.15, 8, 6);
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x334455, metalness: 0.9, roughness: 0.2 });
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(px, 4, pz);
      scene.add(pole);

      const lampGeo = new THREE.SphereGeometry(0.4, 8, 8);
      const lampMat = new THREE.MeshBasicMaterial({ color: i % 2 === 0 ? 0x00ffff : 0xff00ff });
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(px, 8.5, pz);
      scene.add(lamp);

      const sLight = new THREE.PointLight(i % 2 === 0 ? 0x00ffff : 0xff00ff, 1.2, 30);
      sLight.position.copy(lamp.position);
      scene.add(sLight);
    }
  }
}

function buildVehicle(THREE) {
  vehicleBody = new THREE.Group();
  scene.add(vehicleBody);

  const isCar = G.vehicleType === 'car';
  const bodyColor = isCar ? 0x00ddff : 0xff00cc;
  const accentColor = isCar ? 0x0044aa : 0x880044;

  // Main body
  const bodyGeo = isCar
    ? new THREE.BoxGeometry(2.2, 0.7, 4.6)
    : new THREE.BoxGeometry(0.7, 1.0, 4.0);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor, metalness: 0.9, roughness: 0.15,
    emissive: bodyColor, emissiveIntensity: 0.08
  });
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.position.y = isCar ? 0.5 : 0.6;
  bodyMesh.castShadow = true;
  vehicleBody.add(bodyMesh);

  // Cabin/cockpit
  const cabGeo = isCar
    ? new THREE.BoxGeometry(1.8, 0.65, 2.4)
    : new THREE.BoxGeometry(0.6, 0.6, 1.2);
  const cabMat = new THREE.MeshStandardMaterial({
    color: 0x001122, metalness: 0.7, roughness: 0.3,
    transparent: true, opacity: 0.85
  });
  const cab = new THREE.Mesh(cabGeo, cabMat);
  cab.position.y = isCar ? 1.1 : 1.25;
  cab.position.z = isCar ? -0.3 : 0.2;
  vehicleBody.add(cab);

  // Neon underglow
  const glowLight = new THREE.PointLight(bodyColor, 3, 8);
  glowLight.position.y = -0.2;
  vehicleBody.add(glowLight);

  // Headlights
  for (const side of [-1, 1]) {
    const hl = new THREE.PointLight(0xaaddff, 4, 30);
    hl.position.set(side * 0.9, 0.4, -2.2);
    vehicleBody.add(hl);
    const hlMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xaaddff })
    );
    hlMesh.position.copy(hl.position);
    vehicleBody.add(hlMesh);
  }

  // Wheels
  wheelMeshes = [];
  const wheelPositions = isCar
    ? [[-1.1, 0.18, -1.6], [1.1, 0.18, -1.6], [-1.1, 0.18, 1.6], [1.1, 0.18, 1.6]]
    : [[-0.45, 0.18, -1.6], [0.45, 0.18, -1.6], [-0.45, 0.18, 1.6], [0.45, 0.18, 1.6]];

  wheelPositions.forEach((pos, idx) => {
    const wGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.22, 12);
    const wMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.5, roughness: 0.8 });
    const wheel = new THREE.Mesh(wGeo, wMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(...pos);
    wheel.castShadow = true;

    // Rim
    const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.24, 8);
    const rimMat = new THREE.MeshStandardMaterial({ color: accentColor, metalness: 1, roughness: 0.1, emissive: bodyColor, emissiveIntensity: 0.3 });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    wheel.add(rim);

    vehicleBody.add(wheel);
    wheelMeshes.push({ mesh: wheel, isFront: idx < 2 });
  });

  // Set start position
  const startPos = getTrackPos(0);
  vehicleBody.position.set(startPos.x, 0, startPos.z);
  CAR.x = startPos.x; CAR.z = startPos.z;
  CAR.angle = 0;
}

function buildParticles(THREE) {
  // Nitro particle system
  const pCount = 400;
  const pGeo = new THREE.BufferGeometry();
  const pPositions = new Float32Array(pCount * 3);
  const pColors = new Float32Array(pCount * 3);
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pColors, 3));
  const pMat = new THREE.PointsMaterial({ size: 0.3, vertexColors: true, transparent: true, opacity: 0.8 });
  nitroParticles = new THREE.Points(pGeo, pMat);
  nitroParticles.visible = false;
  scene.add(nitroParticles);

  // Spark system for drifting
  const sCount = 200;
  const sGeo = new THREE.BufferGeometry();
  const sPos = new Float32Array(sCount * 3);
  sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  particleSystem = {
    geo: sGeo, pos: sPos, count: sCount,
    particles: Array.from({length: sCount}, () => ({ active: false, x:0,y:0,z:0, vx:0,vy:0,vz:0, life:0 })),
    mesh: new THREE.Points(sGeo, new THREE.PointsMaterial({ color: 0xff8800, size: 0.18, transparent: true, opacity: 0.9 }))
  };
  scene.add(particleSystem.mesh);
}

function spawnSpark(x, y, z) {
  const p = particleSystem.particles.find(p => !p.active);
  if (!p) return;
  p.active = true; p.x=x; p.y=y; p.z=z;
  p.vx = (Math.random()-0.5)*4; p.vy = Math.random()*3+1; p.vz = (Math.random()-0.5)*4;
  p.life = 1;
}

function updateParticles(dt) {
  const pos = particleSystem.pos;
  particleSystem.particles.forEach((p, i) => {
    if (!p.active) { pos[i*3+1] = -1000; return; }
    p.x += p.vx*dt; p.y += p.vy*dt; p.z += p.vz*dt;
    p.vy -= 6*dt;
    p.life -= dt*2;
    if (p.life <= 0) p.active = false;
    pos[i*3]=p.x; pos[i*3+1]=p.y; pos[i*3+2]=p.z;
  });
  particleSystem.geo.attributes.position.needsUpdate = true;
}

function updateNitroParticles(dt) {
  if (!GESTURE.nitro) { nitroParticles.visible = false; return; }
  nitroParticles.visible = true;
  const pos = nitroParticles.geometry.attributes.position.array;
  const col = nitroParticles.geometry.attributes.color.array;
  const count = pos.length / 3;
  const rearX = CAR.x + Math.sin(CAR.angle) * 2.5;
  const rearZ = CAR.z + Math.cos(CAR.angle) * 2.5;
  for (let i = 0; i < count; i++) {
    const age = i / count;
    const spread = age * 2;
    pos[i*3]   = rearX + (Math.random()-0.5)*spread;
    pos[i*3+1] = 0.3 + Math.random() * age * 1.5;
    pos[i*3+2] = rearZ + Math.sin(CAR.angle + Math.PI) * age * 6 + (Math.random()-0.5)*spread;
    const t = 1 - age;
    col[i*3]=t; col[i*3+1]=t*0.8; col[i*3+2]=1;
  }
  nitroParticles.geometry.attributes.position.needsUpdate = true;
  nitroParticles.geometry.attributes.color.needsUpdate = true;
}

function buildMinimap(THREE) {
  minimapScene = new THREE.Scene();
  minimapCamera = new THREE.OrthographicCamera(-280, 280, 280, -280, 0.1, 1000);
  minimapCamera.position.set(0, 500, 0);
  minimapCamera.lookAt(0, 0, 0);

  // Track line on minimap
  const mmTrackPts = [];
  for (let i = 0; i <= 128; i++) {
    const t = (i/128)*Math.PI*2;
    const p = getTrackPos(t);
    mmTrackPts.push(new THREE.Vector3(p.x, 0, p.z));
  }
  const mmGeo = new THREE.BufferGeometry().setFromPoints(mmTrackPts);
  minimapScene.add(new THREE.Line(mmGeo, new THREE.LineBasicMaterial({ color: 0x00ffff })));

  // Player dot
  const dotGeo = new THREE.SphereGeometry(5, 6, 6);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const dot = new THREE.Mesh(dotGeo, dotMat);
  dot.position.y = 1;
  minimapScene.add(dot);
  window._mmDot = dot;
}

function getClosestTrackT(pos) {
  let best = 0, bestDist = Infinity;
  const N = 128;
  for (let i = 0; i < N; i++) {
    const t = (i/N)*Math.PI*2;
    const p = getTrackPos(t);
    const d = Math.sqrt((pos.x-p.x)**2 + (pos.z-p.z)**2);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

// ════════════════════════════════════════════════════════════
// PHYSICS UPDATE
// ════════════════════════════════════════════════════════════
function updatePhysics(dt) {
  const cfg = VEHICLE_CFG[G.vehicleType];
  const nitroActive = GESTURE.nitro && CAR.nitro > 0;
  const nitroMult = nitroActive ? cfg.nitroMult : 1.0;

  // Gear shift based on speed
  const speedKmh = Math.abs(CAR.speed) * 3.6;
  if (speedKmh < 2) CAR.gear = GESTURE.brake > 0.3 && CAR.speed < 0 ? -1 : 0;
  else if (speedKmh < 18) CAR.gear = 1;
  else if (speedKmh < 32) CAR.gear = 2;
  else if (speedKmh < 58) CAR.gear = 3;
  else if (speedKmh < 90) CAR.gear = 4;
  else if (speedKmh < 130) CAR.gear = 5;
  else CAR.gear = 6;

  // RPM
  const gearRatio = cfg.gearRatios[Math.abs(CAR.gear)] || 1;
  CAR.rpm = Math.min(100, (Math.abs(CAR.speed) / cfg.maxSpeed) * 100 * gearRatio + GESTURE.throttle * 20);

  // Nitro management
  if (nitroActive) {
    CAR.nitro = Math.max(0, CAR.nitro - dt * 20);
  } else {
    CAR.nitro = Math.min(100, CAR.nitro + dt * 8);
  }

  // Steering
  const targetSteer = GESTURE.steer * cfg.steerMax * Math.min(1, Math.abs(CAR.speed) * 0.25 + 0.2);
  CAR.steerAngle += (targetSteer - CAR.steerAngle) * cfg.steerReturn * dt * 60;

  // Acceleration / brake forces
  let driveForce = GESTURE.throttle * cfg.accel * nitroMult;
  let brakeForce = GESTURE.brake * cfg.brakeForce;

  const maxSpd = cfg.maxSpeed * nitroMult;
  if (Math.abs(CAR.speed) < maxSpd || (driveForce > 0 && CAR.speed < 0) || driveForce < 0) {
    CAR.speed += (driveForce - brakeForce * Math.sign(CAR.speed)) * dt;
  }

  // Drag
  CAR.speed *= Math.pow(0.985, dt * 60);

  // Clamp
  CAR.speed = Math.max(-cfg.maxSpeed * 0.4, Math.min(maxSpd, CAR.speed));

  // Turn rate proportional to speed
  const turnRate = CAR.steerAngle * Math.min(1, Math.abs(CAR.speed) * 0.18);
  CAR.angle += turnRate * dt * 60;

  // Lateral grip / drift
  const lateralSlip = Math.abs(Math.sin(CAR.steerAngle) * CAR.speed);
  CAR.drifting = lateralSlip > cfg.driftThreshold * 0.04 && Math.abs(CAR.speed) > 4;
  CAR.driftIntensity = Math.min(1, lateralSlip / 8);

  if (CAR.drifting && Math.random() < 0.4) {
    const wx = CAR.x - Math.sin(CAR.angle) * 1.5;
    const wz = CAR.z - Math.cos(CAR.angle) * 1.5;
    spawnSpark(wx, 0.1, wz);
    spawnSpark(wx + Math.cos(CAR.angle)*0.8, 0.1, wz - Math.sin(CAR.angle)*0.8);
  }

  // Move
  CAR.x -= Math.sin(CAR.angle) * CAR.speed * dt;
  CAR.z -= Math.cos(CAR.angle) * CAR.speed * dt;

  // Bike lean
  if (G.vehicleType === 'bike') {
    CAR.lean += (-CAR.steerAngle * 28 - CAR.lean) * 4 * dt;
  }

  // Wheel spin
  wheelMeshes.forEach(({ mesh, isFront }) => {
    mesh.rotation.x += CAR.speed * dt * 3.5;
    if (isFront) {
      mesh.rotation.y = -CAR.steerAngle * 8;
    }
  });

  // Minimap dot
  if (window._mmDot) {
    window._mmDot.position.x = CAR.x;
    window._mmDot.position.z = CAR.z;
  }

  // Lap tracking
  const t = getClosestTrackT({ x: CAR.x, z: CAR.z });
  const checkpoint = Math.floor((t / (Math.PI * 2)) * 8);
  if (checkpoint !== CAR.lastCheckpoint) {
    if (checkpoint === 0 && CAR.lastCheckpoint === 7) {
      // Crossed finish
      if (G.lap < G.totalLaps) G.lap++;
      else if (G.running) { G.finished = true; }
    }
    CAR.lastCheckpoint = checkpoint;
  }
}

// ════════════════════════════════════════════════════════════
// CAMERA FOLLOW
// ════════════════════════════════════════════════════════════
const CAM_LERP = 0.06;
let camAngle = 0, camTargetX = 0, camTargetZ = 0;

function updateCamera() {
  const dist = 10, height = 4.5;
  camTargetX += (-Math.sin(CAR.angle) * dist - camTargetX) * CAM_LERP * 2;
  camTargetZ += (-Math.cos(CAR.angle) * dist - camTargetZ) * CAM_LERP * 2;
  camera.position.x += (CAR.x + camTargetX - camera.position.x) * CAM_LERP;
  camera.position.y += (height + Math.abs(CAR.speed) * 0.08 - camera.position.y) * CAM_LERP;
  camera.position.z += (CAR.z + camTargetZ - camera.position.z) * CAM_LERP;

  const lookX = CAR.x - Math.sin(CAR.angle) * 3;
  const lookZ = CAR.z - Math.cos(CAR.angle) * 3;
  camera.lookAt(lookX, 1.2, lookZ);

  // Nitro FOV
  const targetFov = GESTURE.nitro ? 85 : 65;
  camera.fov += (targetFov - camera.fov) * 0.05;
  camera.updateProjectionMatrix();
}

// ════════════════════════════════════════════════════════════
// VEHICLE MESH UPDATE
// ════════════════════════════════════════════════════════════
function updateVehicleMesh() {
  vehicleBody.position.x = CAR.x;
  vehicleBody.position.z = CAR.z;
  vehicleBody.position.y = 0.2;
  vehicleBody.rotation.y = CAR.angle;
  if (G.vehicleType === 'bike') {
    vehicleBody.rotation.z = CAR.lean * 0.018;
  }
  // Suspension bounce
  vehicleBody.position.y += Math.sin(frameCount * 0.2) * Math.min(0.04, Math.abs(CAR.speed) * 0.001);
}

// ════════════════════════════════════════════════════════════
// MEDIAPIPE GESTURE SYSTEM
// ════════════════════════════════════════════════════════════
let handsInstance, cameraInstance;
const PiP_W = 200, PiP_H = 150;

function fingerExtended(lm, tip, pip) {
  return lm[tip].y < lm[pip].y;
}

function isHandOpen(lm) {
  return fingerExtended(lm,8,6) && fingerExtended(lm,12,10) &&
         fingerExtended(lm,16,14) && fingerExtended(lm,20,18);
}

function isHandClosed(lm) {
  return !fingerExtended(lm,8,6) && !fingerExtended(lm,12,10) &&
         !fingerExtended(lm,16,14) && !fingerExtended(lm,20,18);
}

async function initMediaPipe() {
  // Load scripts dynamically
  await loadScript(MP_HANDS);
  await loadScript(MP_CAM);
  await loadScript(MP_DRAW);

  const video = document.getElementById('camVideo');
  const camCanvas = document.getElementById('camCanvas');
  const camCtx = camCanvas.getContext('2d');
  camCanvas.width = PiP_W; camCanvas.height = PiP_H;

  const Hands = window.Hands;
  if (!Hands) { console.warn('MediaPipe Hands not loaded'); return; }

  handsInstance = new Hands({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${f}`
  });
  handsInstance.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.6
  });

  handsInstance.onResults(results => {
    camCtx.clearRect(0, 0, PiP_W, PiP_H);
    camCtx.save();
    camCtx.scale(-1, 1);
    camCtx.translate(-PiP_W, 0);
    camCtx.scale(PiP_W / results.image.width, PiP_H / results.image.height);

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      GESTURE.handsDetected = true;

      const draw = window.drawConnectors, style = window.HAND_CONNECTIONS;

      results.multiHandLandmarks.forEach((lm, idx) => {
        if (window.drawConnectors && window.HAND_CONNECTIONS) {
          window.drawConnectors(camCtx, lm, window.HAND_CONNECTIONS,
            { color: idx === 0 ? '#00ffff' : '#ff00ff', lineWidth: 1.5 });
          window.drawLandmarks(camCtx, lm, { color: '#ffffff', lineWidth: 1, radius: 2 });
        }

        // Determine handedness
        const hand = results.multiHandedness[idx]?.label || 'Right';

        if (hand === 'Right') {
          // Throttle: open hand
          GESTURE._throttle = isHandOpen(lm) ? 1 : 0;
          // Brake: closed fist
          GESTURE._brake = isHandClosed(lm) ? 1 : 0;
        }
        if (hand === 'Left') {
          // Nitro: open left hand
          GESTURE._nitro = isHandOpen(lm);
        }
      });

      // Steering: if 2 hands, use wrist midpoint angle
      if (results.multiHandLandmarks.length === 2) {
        const lh = results.multiHandLandmarks[0];
        const rh = results.multiHandLandmarks[1];
        // Use wrist positions to determine "wheel" angle
        const lwx = lh[0].x, lwy = lh[0].y;
        const rwx = rh[0].x, rwy = rh[0].y;
        const dx = rwx - lwx;
        const dy = rwy - lwy;
        // Angle of the "wheel" line
        const angle = Math.atan2(dy, dx);
        // Map to steer: neutral at 0, tilted CW = right, CCW = left
        GESTURE._steer = Math.max(-1, Math.min(1, angle * 2.5));
      } else if (results.multiHandLandmarks.length === 1) {
        const lm = results.multiHandLandmarks[0];
        // Single hand: use wrist X position
        const wx = lm[0].x; // 0 left, 1 right (but mirrored)
        GESTURE._steer = (0.5 - wx) * 2.4;
        GESTURE._steer = Math.max(-1, Math.min(1, GESTURE._steer));
      }

    } else {
      GESTURE.handsDetected = false;
      GESTURE._throttle = 0;
      GESTURE._brake = 0;
      GESTURE._nitro = false;
    }
    camCtx.restore();
  });

  const Camera = window.Camera;
  if (!Camera) { console.warn('MediaPipe Camera not loaded'); return; }

  cameraInstance = new Camera(video, {
    onFrame: async () => { await handsInstance.send({ image: video }); },
    width: 320, height: 240
  });
  cameraInstance.start().catch(e => {
    console.warn('Camera failed:', e);
    document.getElementById('camStatus').innerHTML = '<span class="dot" style="background:#f00;box-shadow:0 0 4px #f00"></span> NO CAM';
  });
}

// Smooth gesture filtering (lerp)
function smoothGestures(dt) {
  const alpha = Math.min(1, dt * 12); // Low-pass
  GESTURE.steer += (GESTURE._steer - GESTURE.steer) * alpha;
  GESTURE.throttle += (GESTURE._throttle - GESTURE.throttle) * alpha;
  GESTURE.brake += (GESTURE._brake - GESTURE.brake) * alpha;
  GESTURE.nitro = GESTURE._nitro;
}

function updateGestureHUD() {
  const sv = GESTURE.steer;
  document.getElementById('gf-steer-val').textContent = sv > 0.1 ? `→ ${(sv*100).toFixed(0)}%` : sv < -0.1 ? `← ${(-sv*100).toFixed(0)}%` : 'CENTER';
  document.getElementById('gf-gas-val').textContent = GESTURE.throttle > 0.3 ? `${(GESTURE.throttle*100).toFixed(0)}%` : 'OFF';
  document.getElementById('gf-brake-val').textContent = GESTURE.brake > 0.3 ? `${(GESTURE.brake*100).toFixed(0)}%` : 'OFF';
  document.getElementById('gf-nitro-val').textContent = GESTURE.nitro ? 'ON 🚀' : 'OFF';
}

// ════════════════════════════════════════════════════════════
// NEON LIGHTS PULSE ANIMATION
// ════════════════════════════════════════════════════════════
function animateLights(t) {
  neonLights.forEach((light, i) => {
    light.intensity = 2 + Math.sin(t * 2 + i * 0.8) * 0.8;
  });
  // Ambient night pulse
  if (ambLight) {
    ambLight.intensity = 0.9 + Math.sin(t * 0.5) * 0.1;
  }
}

// ════════════════════════════════════════════════════════════
// HUD UPDATES
// ════════════════════════════════════════════════════════════
function updateHUD(dt) {
  const speedKmh = Math.round(Math.abs(CAR.speed) * 3.6);
  document.getElementById('speedVal').textContent = speedKmh;
  document.getElementById('rpmFill').style.width = CAR.rpm + '%';
  document.getElementById('rpmFill').style.background = CAR.rpm > 85 ? '#ff3a3a' : CAR.rpm > 65 ? '#ff8800' : 'linear-gradient(90deg,#0ff,#f0f)';
  const gearStr = CAR.gear === 0 ? 'N' : CAR.gear === -1 ? 'R' : CAR.gear;
  document.getElementById('gearVal').textContent = gearStr;
  document.getElementById('nitroFill').style.height = CAR.nitro + '%';
  document.getElementById('lapVal').textContent = `${G.lap} / ${G.totalLaps}`;

  // Timer
  if (G.running && G.startTime) {
    const elapsed = (performance.now() - G.startTime) / 1000;
    const m = Math.floor(elapsed / 60);
    const s = (elapsed % 60).toFixed(2);
    document.getElementById('timeVal').textContent = `${m}:${s.padStart(5,'0')}`;
  }

  // Drift/Nitro indicators
  document.getElementById('driftIndicator').classList.toggle('show', CAR.drifting);
  document.getElementById('nitroIndicator').classList.toggle('show', GESTURE.nitro && CAR.nitro > 0);

  // Nitro screen flash
  const flash = document.getElementById('nitroFlash');
  if (flash) flash.classList.toggle('active', GESTURE.nitro && CAR.nitro > 0);

  updateGestureHUD();
}

// ════════════════════════════════════════════════════════════
// MINIMAP RENDER
// ════════════════════════════════════════════════════════════
function renderMinimap() {
  if (!minimapScene || !minimapCamera) return;
  const mmCanvas = document.getElementById('minimap');
  if (!mmCanvas) return;

  const offRenderer = new (window._THREE.WebGLRenderer)({ canvas: mmCanvas, antialias: false, alpha: true });
  offRenderer.setSize(140, 140);
  offRenderer.setClearColor(0x000814, 0.85);
  offRenderer.render(minimapScene, minimapCamera);
  offRenderer.dispose();
}

// ════════════════════════════════════════════════════════════
// MAIN GAME LOOP
// ════════════════════════════════════════════════════════════
let animId, lastMmTime = 0;

function gameLoop(time) {
  animId = requestAnimationFrame(gameLoop);
  const dt = Math.min(clock.getDelta(), 0.05);
  frameCount++;

  if (!G.running) return;

  smoothGestures(dt);
  updatePhysics(dt);
  updateVehicleMesh();
  updateCamera();
  updateParticles(dt);
  updateNitroParticles(dt);
  animateLights(time * 0.001);
  updateHUD(dt);
  updateAudio(dt);

  // Minimap: update every 6 frames
  if (frameCount % 6 === 0) renderMinimap();

  renderer.render(scene, camera);
}

// ════════════════════════════════════════════════════════════
// COUNTDOWN
// ════════════════════════════════════════════════════════════
function startCountdown() {
  let el = document.getElementById('countdown');
  if (!el) {
    el = document.createElement('div');
    el.id = 'countdown';
    document.getElementById('game-screen').appendChild(el);
    const flash = document.createElement('div');
    flash.id = 'nitroFlash';
    document.getElementById('game-screen').appendChild(flash);
  }
  G.countdownActive = true;
  let n = 3;
  el.style.opacity = '1';
  el.textContent = n;
  const iv = setInterval(() => {
    n--;
    if (n > 0) {
      el.textContent = n;
      el.style.color = '#ff8800';
    } else {
      el.textContent = 'GO!';
      el.style.color = '#00ff88';
      setTimeout(() => {
        el.style.opacity = '0';
        G.running = true;
        G.countdownActive = false;
        G.startTime = performance.now();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        engineGain && (engineGain.gain.value = 0.05);
      }, 700);
      clearInterval(iv);
    }
  }, 900);
}

// ════════════════════════════════════════════════════════════
// INIT & MENU CONTROL
// ════════════════════════════════════════════════════════════
let selectedVehicle = 'car';

function selectVehicle(type) {
  selectedVehicle = type;
  document.getElementById('v-car').classList.toggle('active', type === 'car');
  document.getElementById('v-bike').classList.toggle('active', type === 'bike');
}

async function startGame() {
  G.vehicleType = selectedVehicle;

  // Show game screen
  document.getElementById('menu-screen').classList.remove('active');
  document.getElementById('game-screen').classList.add('active');

  // Init Three.js if not already
  if (!window._THREE_READY) {
    await initThree();
  } else {
    // Rebuild vehicle for new selection
    if (vehicleBody) { scene.remove(vehicleBody); vehicleBody = null; }
    buildVehicle(window._THREE);
  }

  // Reset state
  G.running = false; G.lap = 1; G.finished = false;
  CAR.x = getTrackPos(0).x; CAR.z = getTrackPos(0).z;
  CAR.angle = 0; CAR.speed = 0; CAR.rpm = 0; CAR.gear = 0;
  CAR.nitro = 100; CAR.drifting = false; CAR.lean = 0;
  GESTURE.steer = 0; GESTURE.throttle = 0; GESTURE.brake = 0; GESTURE.nitro = false;
  GESTURE._steer = 0; GESTURE._throttle = 0; GESTURE._brake = 0;

  // Init audio
  initAudio();

  // Init gesture (only once)
  if (!handsInstance) initMediaPipe();

  // Start loop
  if (animId) cancelAnimationFrame(animId);
  clock.start();
  gameLoop(0);

  // Countdown
  setTimeout(startCountdown, 500);
}

function goMenu() {
  G.running = false;
  if (animId) cancelAnimationFrame(animId);
  document.getElementById('game-screen').classList.remove('active');
  document.getElementById('menu-screen').classList.add('active');
  if (engineGain) engineGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.3);
}

function toggleNightMode() {
  G.nightMode = !G.nightMode;
  if (!scene) return;
  if (G.nightMode) {
    scene.fog.color.setHex(0x000814);
    scene.fog.density = 0.006;
    ambLight.color.setHex(0x030820);
    ambLight.intensity = 1.2;
    sunLight.intensity = 0.2;
    renderer.toneMappingExposure = 1.1;
  } else {
    scene.fog.color.setHex(0xaabbcc);
    scene.fog.density = 0.003;
    ambLight.color.setHex(0x88aabb);
    ambLight.intensity = 2.5;
    sunLight.intensity = 1.5;
    renderer.toneMappingExposure = 0.85;
  }
}

// ── Utility ───────────────────────────────────────────────
// Animated intro wallpaper. Kept canvas-only so the menu works before Three.js loads.
let menuWallpaperRaf = 0;

function initMenuWallpaper() {
  const canvas = document.getElementById('menuWallpaper');
  if (!canvas || canvas.dataset.ready === '1') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.dataset.ready = '1';
  const skyline = Array.from({ length: 58 }, (_, i) => {
    const n = Math.sin(i * 12.9898) * 43758.5453;
    const f = n - Math.floor(n);
    return {
      x: i / 57,
      w: 0.012 + f * 0.025,
      h: 0.12 + ((f * 7.13) % 1) * 0.32,
      glow: i % 3 === 0 ? '#00ffff' : i % 3 === 1 ? '#ff00ff' : '#00ff88'
    };
  });

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.dataset.dpr = String(dpr);
  };

  window.addEventListener('resize', resize);
  resize();

  const draw = time => {
    const dpr = Number(canvas.dataset.dpr) || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMenuWallpaper(ctx, w, h, time * 0.001, skyline);
    menuWallpaperRaf = requestAnimationFrame(draw);
  };

  if (menuWallpaperRaf) cancelAnimationFrame(menuWallpaperRaf);
  menuWallpaperRaf = requestAnimationFrame(draw);
}

function drawMenuWallpaper(ctx, w, h, t, skyline) {
  const compact = w < 760;
  const cx = compact ? w * 0.5 : w * 0.69;
  const horizon = h * (compact ? 0.42 : 0.46);

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#020512');
  bg.addColorStop(0.45, '#06102a');
  bg.addColorStop(1, '#03040a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const skyGlow = ctx.createRadialGradient(cx, horizon, 0, cx, horizon, Math.max(w, h) * 0.62);
  skyGlow.addColorStop(0, 'rgba(0,255,255,0.22)');
  skyGlow.addColorStop(0.28, 'rgba(255,0,255,0.1)');
  skyGlow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = skyGlow;
  ctx.fillRect(0, 0, w, h);

  drawSkyline(ctx, w, h, horizon, skyline, t);
  drawRoad(ctx, w, h, cx, horizon, t);
  drawSpeedTrails(ctx, w, h, cx, horizon, t);
  drawHeroCar(ctx, cx, h * (compact ? 0.75 : 0.72), Math.min(w * (compact ? 0.76 : 0.42), 520), t);
}

function drawSkyline(ctx, w, h, horizon, skyline, t) {
  ctx.save();
  skyline.forEach((b, i) => {
    const bw = b.w * w;
    const bh = b.h * h;
    const x = b.x * w - bw * 0.5;
    const y = horizon - bh;
    const grad = ctx.createLinearGradient(0, y, 0, horizon);
    grad.addColorStop(0, 'rgba(11,24,58,0.92)');
    grad.addColorStop(1, 'rgba(3,8,22,0.98)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, bw, bh);

    ctx.fillStyle = b.glow;
    ctx.globalAlpha = 0.25 + Math.sin(t * 1.4 + i) * 0.08;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 2; col++) {
        if ((row + col + i) % 2 === 0) {
          ctx.fillRect(x + bw * (0.25 + col * 0.34), y + bh * (0.16 + row * 0.1), Math.max(1, bw * 0.08), Math.max(2, bh * 0.025));
        }
      }
    }
    ctx.globalAlpha = 1;
  });
  ctx.restore();
}

function drawRoad(ctx, w, h, cx, horizon, t) {
  const nearW = w * 1.18;
  const farW = w * 0.16;
  const bottom = h + 16;

  const road = ctx.createLinearGradient(0, horizon, 0, bottom);
  road.addColorStop(0, '#091326');
  road.addColorStop(1, '#04050a');

  ctx.beginPath();
  ctx.moveTo(cx - farW * 0.5, horizon);
  ctx.lineTo(cx + farW * 0.5, horizon);
  ctx.lineTo(cx + nearW * 0.5, bottom);
  ctx.lineTo(cx - nearW * 0.5, bottom);
  ctx.closePath();
  ctx.fillStyle = road;
  ctx.fill();

  for (let side = -1; side <= 1; side += 2) {
    ctx.strokeStyle = side < 0 ? 'rgba(255,0,255,0.72)' : 'rgba(0,255,255,0.72)';
    ctx.lineWidth = 2;
    ctx.shadowColor = side < 0 ? '#ff00ff' : '#00ffff';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(cx + side * farW * 0.52, horizon);
    ctx.lineTo(cx + side * nearW * 0.5, bottom);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  for (let i = 0; i < 18; i++) {
    const p = (i / 18 + (t * 0.65) % 1) % 1;
    const q = p * p;
    const y = horizon + (bottom - horizon) * q;
    const width = farW + (nearW - farW) * q;
    const dash = 8 + q * 64;
    ctx.strokeStyle = `rgba(255,255,255,${0.1 + q * 0.46})`;
    ctx.lineWidth = 1 + q * 4;
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(cx, y + dash);
    ctx.stroke();

    ctx.strokeStyle = `rgba(0,255,255,${0.08 + q * 0.22})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - width * 0.26, y);
    ctx.lineTo(cx + width * 0.26, y);
    ctx.stroke();
  }
}

function drawSpeedTrails(ctx, w, h, cx, horizon, t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 34; i++) {
    const p = (i / 34 + (t * 0.95) % 1) % 1;
    const q = p * p;
    const y = horizon + (h - horizon) * q;
    const spread = 60 + q * w * 0.54;
    const side = i % 2 === 0 ? -1 : 1;
    const x = cx + side * (spread * (0.55 + ((i * 17) % 19) / 52));
    const len = 30 + q * 150;
    ctx.strokeStyle = i % 3 === 0 ? 'rgba(255,0,255,0.28)' : 'rgba(0,255,255,0.28)';
    ctx.lineWidth = 1 + q * 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + side * len * 0.35, y + len);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHeroCar(ctx, x, y, width, t) {
  const w = width;
  const h = width * 0.38;
  const bob = Math.sin(t * 4) * 2.5;

  ctx.save();
  ctx.translate(x, y + bob);

  ctx.shadowColor = '#00ffff';
  ctx.shadowBlur = 22;
  const shadow = ctx.createRadialGradient(0, h * 0.34, w * 0.08, 0, h * 0.34, w * 0.62);
  shadow.addColorStop(0, 'rgba(0,255,255,0.22)');
  shadow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.ellipse(0, h * 0.34, w * 0.62, h * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#05070c';
  ctx.beginPath();
  ctx.ellipse(-w * 0.33, h * 0.2, w * 0.13, h * 0.2, 0, 0, Math.PI * 2);
  ctx.ellipse(w * 0.33, h * 0.2, w * 0.13, h * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();

  const body = ctx.createLinearGradient(-w * 0.5, -h * 0.28, w * 0.5, h * 0.22);
  body.addColorStop(0, '#061931');
  body.addColorStop(0.28, '#00d5ff');
  body.addColorStop(0.52, '#f5fbff');
  body.addColorStop(0.74, '#cc20ff');
  body.addColorStop(1, '#230628');

  ctx.beginPath();
  ctx.moveTo(-w * 0.48, h * 0.11);
  ctx.lineTo(-w * 0.32, -h * 0.18);
  ctx.lineTo(-w * 0.12, -h * 0.31);
  ctx.lineTo(w * 0.12, -h * 0.31);
  ctx.lineTo(w * 0.32, -h * 0.18);
  ctx.lineTo(w * 0.48, h * 0.11);
  ctx.lineTo(w * 0.42, h * 0.29);
  ctx.lineTo(-w * 0.42, h * 0.29);
  ctx.closePath();
  ctx.fillStyle = body;
  ctx.shadowColor = '#00ffff';
  ctx.shadowBlur = 18;
  ctx.fill();
  ctx.shadowBlur = 0;

  const glass = ctx.createLinearGradient(0, -h * 0.32, 0, h * 0.02);
  glass.addColorStop(0, 'rgba(210,255,255,0.88)');
  glass.addColorStop(1, 'rgba(0,31,70,0.78)');
  ctx.beginPath();
  ctx.moveTo(-w * 0.19, -h * 0.22);
  ctx.lineTo(-w * 0.09, -h * 0.36);
  ctx.lineTo(w * 0.09, -h * 0.36);
  ctx.lineTo(w * 0.19, -h * 0.22);
  ctx.lineTo(w * 0.13, -h * 0.08);
  ctx.lineTo(-w * 0.13, -h * 0.08);
  ctx.closePath();
  ctx.fillStyle = glass;
  ctx.fill();

  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = 'rgba(0,255,255,0.9)';
  ctx.shadowColor = '#00ffff';
  ctx.shadowBlur = 18;
  roundedRect(ctx, -w * 0.38, h * 0.02, w * 0.19, h * 0.045, 8);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,0,255,0.9)';
  ctx.shadowColor = '#ff00ff';
  roundedRect(ctx, w * 0.19, h * 0.02, w * 0.19, h * 0.045, 8);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.lineWidth = 2;
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(-w * 0.32, -h * 0.18);
  ctx.lineTo(w * 0.32, -h * 0.18);
  ctx.stroke();
  ctx.restore();
}

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.crossOrigin = 'anonymous';
    s.onload = res; s.onerror = () => { console.warn('Failed:', src); res(); };
    document.head.appendChild(s);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMenuWallpaper);
} else {
  initMenuWallpaper();
}

// Expose to HTML
window.selectVehicle = selectVehicle;
window.startGame = startGame;
window.goMenu = goMenu;
window.toggleNightMode = toggleNightMode;
