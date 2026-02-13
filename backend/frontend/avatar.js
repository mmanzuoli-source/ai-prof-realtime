// avatar.js
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MODEL_URL = "/app/models/avatar.glb";

let scene, camera, renderer;
let mixer = null;
let clock = new THREE.Clock();
let currentTalkingIntensity = 0;
let containerRef = null;
let modelRoot = null;
let baseAction = null;

export function initAvatar3D() {
  const container = document.getElementById("avatar-3d");
  if (!container) {
    console.warn("Container #avatar-3d non trovato");
    return;
  }
  containerRef = container;

  const width = container.clientWidth;
  const height = container.clientHeight || 480;

  scene = new THREE.Scene();
  // niente background colore: lasciamo trasparente
  // scene.background = new THREE.Color(0x020617);

  camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
  camera.position.set(0, 2.3, 1.0);

  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(2, 4, 3);
  scene.add(dir);

  // renderer con alpha: true per rendere il canvas trasparente
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio || 1);

  // opzionale: assicuriamo che lo sfondo del canvas sia trasparente
  renderer.setClearColor(0x000000, 0); // alpha = 0

  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  const loader = new GLTFLoader();
  loader.load(
    MODEL_URL,
    (gltf) => {
      const model = gltf.scene;
      modelRoot = model;

      model.traverse((obj) => {
        if (obj.isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
      });

      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);

      const maxSize = Math.max(size.x, size.y, size.z) || 1;
      const scale = 2.2 / maxSize;
      model.scale.set(scale, scale, scale);

      model.position.sub(center.multiplyScalar(scale));
      model.position.y += 0.2;

      scene.add(model);

      mixer = new THREE.AnimationMixer(model);
      const clips = gltf.animations || [];
      console.log("Animazioni avatar:", clips.map((c) => c.name));

      if (clips.length > 0) {
        const clip =
          clips.find((c) => c.name === "Standard_Smoking") || clips[0];

        baseAction = mixer.clipAction(clip);
        baseAction.reset();
        baseAction.loop = THREE.LoopRepeat; // sempre in loop
        baseAction.clampWhenFinished = false;
        baseAction.enabled = true;
        baseAction.weight = 1.0;
        baseAction.play();
      }

      animate();
    },
    undefined,
    (error) => {
      console.error("Errore caricamento modello 3D:", error);
      const geo = new THREE.BoxGeometry(1.2, 1.2, 1.2);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x2563eb,
        emissive: 0x1d4ed8,
        metalness: 0.3,
        roughness: 0.4,
      });
      const cube = new THREE.Mesh(geo, mat);
      cube.position.y = 1.0;
      scene.add(cube);
      animate();
    }
  );
}

function animate() {
  if (!renderer || !scene || !camera) return;

  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const t = clock.elapsedTime;

  if (mixer && baseAction) {
    const speed = 0.6 + currentTalkingIntensity * 1.4;
    mixer.update(delta * speed);
  }

  if (modelRoot) {
    const talk = THREE.MathUtils.clamp(currentTalkingIntensity, 0, 1);
    if (talk > 0.01) {
      const ampRot = 0.08 * talk;
      const ampPos = 0.03 * talk;
      modelRoot.rotation.y = Math.sin(t * 2.0) * ampRot;
      modelRoot.rotation.x = Math.sin(t * 1.7) * ampRot * 0.6;
      modelRoot.position.y = 0.5 + Math.sin(t * 3.0) * ampPos * 0.1;
    } else {
      modelRoot.rotation.x *= 0.9;
      modelRoot.rotation.y *= 0.9;
      modelRoot.position.y += (0.5 - modelRoot.position.y) * 0.1;
    }
  }

  renderer.render(scene, camera);
}

export function resizeAvatar() {
  if (!containerRef || !camera || !renderer) return;
  const width = containerRef.clientWidth;
  const height = containerRef.clientHeight || 480;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

export function setTalkingIntensity(intensity) {
  currentTalkingIntensity = THREE.MathUtils.clamp(intensity || 0, 0, 1);
}
