// Three.js viewer for the generated GLB. Loaded from a CDN via the import map in index.html.
const VIEWER_FOV = 40;
const AUTO_ROTATE_SPEED = 1.2;
const FRAME_PADDING = 1.1;
const CAMERA_HEIGHT_RATIO = 0.15;

/**
 * Renders a GLB inside `container` with soft three-point lighting, slow auto-rotation,
 * and the model centered and framed. Resolves to a cleanup function.
 * @param {HTMLElement} container
 * @param {string} url
 * @returns {Promise<() => void>}
 */
export async function mountViewer(container, url) {
  const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
    import('three'),
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/controls/OrbitControls.js'),
  ]);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
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
  controls.autoRotate = true;
  controls.autoRotateSpeed = AUTO_ROTATE_SPEED;

  const { scene: model } = await new GLTFLoader().loadAsync(url);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  model.position.sub(box.getCenter(new THREE.Vector3()));
  scene.add(model);
  const distance = (size.length() / 2) / Math.tan((VIEWER_FOV * Math.PI) / 360) * FRAME_PADDING;
  camera.position.set(0, size.y * CAMERA_HEIGHT_RATIO, distance);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  return () => { observer.disconnect(); renderer.setAnimationLoop(null); renderer.dispose(); container.replaceChildren(); };
}
