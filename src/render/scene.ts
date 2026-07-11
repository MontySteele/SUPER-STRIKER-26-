// Scene, lighting and the PS3 post stack (§7.1): per-pixel lighting, one
// shadow cascade over the play area, bloom, vignette, filmic tone mapping.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export type TimeOfDay = 'day' | 'sunset' | 'night';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: 0.32 },
    saturation: { value: 1.12 },
    contrast: { value: 1.05 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float saturation;
    uniform float contrast;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // punchy broadcast grade
      c.rgb = (c.rgb - 0.5) * contrast + 0.5;
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(vec3(l), c.rgb, saturation);
      // vignette
      float d = distance(vUv, vec2(0.5));
      c.rgb *= 1.0 - vignette * smoothstep(0.35, 0.85, d);
      gl_FragColor = c;
    }
  `,
};

export class SceneManager {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  keyLight: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  bloom: UnrealBloomPass;

  constructor(canvas: HTMLCanvasElement, public timeOfDay: TimeOfDay) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = timeOfDay === 'night' ? 1.15 : 1.05;

    this.camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 1, 900);
    this.camera.position.set(0, 26, 48);
    this.camera.lookAt(0, 0, 0);

    // key light: sun by day, floodlight rig by night
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1);
    this.keyLight.castShadow = true;
    const sc = this.keyLight.shadow.camera;
    sc.left = -62; sc.right = 62; sc.top = 48; sc.bottom = -48;
    sc.near = 10; sc.far = 220;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0012;
    this.scene.add(this.keyLight, this.keyLight.target);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x223322, 0.7);
    this.scene.add(this.hemi);
    this.applyTimeOfDay(timeOfDay);

    // post stack
    this.composer = new EffectComposer(this.renderer);
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(size.clone().multiplyScalar(0.5), 0.35, 0.55, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', this.resizeHandler);
  }

  private resizeHandler = (): void => this.onResize();

  /**
   * Release everything the GPU is holding for this match. A tournament run
   * builds a fresh renderer per match on the same canvas; without this, GPU
   * memory grows monotonically until the context is lost mid-demo.
   */
  dispose(): void {
    window.removeEventListener('resize', this.resizeHandler);
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) {
        for (const v of Object.values(m)) {
          if (v instanceof THREE.Texture) v.dispose();
        }
        m.dispose();
      }
    });
    this.scene.clear();
    this.bloom.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }

  private applyTimeOfDay(tod: TimeOfDay): void {
    if (tod === 'night') {
      this.keyLight.color.set(0xf2f6ff);
      this.keyLight.intensity = 2.3;
      this.keyLight.position.set(-30, 90, 55);
      this.hemi.color.set(0x8899cc);
      this.hemi.groundColor.set(0x1a2a1a);
      this.hemi.intensity = 0.55;
      this.scene.fog = new THREE.Fog(0x060a14, 220, 520);
      this.scene.background = new THREE.Color(0x060a14);
    } else if (tod === 'sunset') {
      this.keyLight.color.set(0xffc890);
      this.keyLight.intensity = 2.2;
      this.keyLight.position.set(-80, 42, 30);
      this.hemi.color.set(0xffb98a);
      this.hemi.groundColor.set(0x2a3320);
      this.hemi.intensity = 0.6;
      this.scene.fog = new THREE.Fog(0x2b1e2e, 250, 600);
      this.scene.background = new THREE.Color(0x2b1e2e);
    } else {
      this.keyLight.color.set(0xfff4e0);
      this.keyLight.intensity = 2.6;
      this.keyLight.position.set(-45, 85, 40);
      this.hemi.color.set(0xbdd7ff);
      this.hemi.groundColor.set(0x2e4a2e);
      this.hemi.intensity = 0.75;
      this.scene.fog = new THREE.Fog(0x9db8d8, 280, 700);
      this.scene.background = new THREE.Color(0x9db8d8);
    }
    this.keyLight.target.position.set(0, 0, 0);
  }

  onResize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  render(): void {
    this.composer.render();
  }
}
