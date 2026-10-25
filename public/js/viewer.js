// Three.js viewer for the generated GLB or STL. Loaded from a CDN via the import map in flakifier.html.
const VIEWER_FOV = 40;
const AUTO_ROTATE_SPEED = 1.2;
const FRAME_PADDING = 1.1;
const CAMERA_HEIGHT_RATIO = 0.15;
const STILL_SIZE_PX = 1024;
/** Above 2x the extra pixels cost GPU memory without a visible difference at this size. */
const MAX_PIXEL_RATIO = 2;

const STL_COLOR = 0xf2c94c;
const STL_ROUGHNESS = 0.35;

/**
 * Loads a GLB scene, or an STL as a single mesh stood upright (STL is Z-up, Three.js Y-up).
 * @param {typeof import('three')} THREE
 * @param {string} url
 * @returns {Promise<import('three').Object3D>}
 */
async function loadModel(THREE, url) {
  if (new URL(url, location.href).pathname.endsWith('.glb')) {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    return (await new GLTFLoader().loadAsync(url)).scene;
  }
  const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
  const geometry = await new STLLoader().loadAsync(url);
  geometry.rotateX(-Math.PI / 2);
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: STL_COLOR, roughness: STL_ROUGHNESS }));
}

/**
 * Renders a GLB or STL inside `container` with soft three-point lighting, slow auto-rotation,
 * and the model centered and framed. Also renders one front-facing still of the model.
 * @param {HTMLElement} container
 * @param {string} url
 * @returns {Promise<{ dispose: () => void, still: string }>} cleanup function and a PNG data URL
 */
export async function mountViewer(container, url) {
  const [THREE, { OrbitControls }] = await Promise.all([
    import('three'),
    import('three/addons/controls/OrbitControls.js'),
  ]);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  container.replaceChildren(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(VIEWER_FOV, 1, 0.01, 1000);
  const addLight = (intensity, x, y, z) => {
    const light = new THREE.DirectionalLight(0xffffff, intensity);
    light.position.set(x, y, z);
    scene.add(light);
  };
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  addLight(2.4, 3, 4, 5);
  addLight(1.0, -4, 1, 3);
  addLight(1.6, 0, 3, -5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  controls.autoRotateSpeed = AUTO_ROTATE_SPEED;

  const model = await loadModel(THREE, url);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  model.position.sub(box.getCenter(new THREE.Vector3()));
  scene.add(model);
  const distance = (size.length() / 2) / Math.tan((VIEWER_FOV * Math.PI) / 360) * FRAME_PADDING;
  camera.position.set(0, size.y * CAMERA_HEIGHT_RATIO, distance);

  // Read the canvas right after rendering: without preserveDrawingBuffer it is cleared
  // once the frame is presented.
  renderer.setSize(STILL_SIZE_PX, STILL_SIZE_PX, false);
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  camera.lookAt(controls.target);
  renderer.render(scene, camera);
  const still = renderer.domElement.toDataURL('image/png');

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return; // hidden: keep the last size rather than a 0 by 0 canvas
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  const dispose = () => {
    observer.disconnect();
    renderer.setAnimationLoop(null);
    controls.dispose();
    // renderer.dispose() does not free what the model uploaded to the GPU.
    model.traverse((object) => {
      object.geometry?.dispose();
      for (const material of [object.material].flat().filter(Boolean)) {
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      }
    });
    renderer.dispose();
    container.replaceChildren();
  };
  return { dispose, still };
}
