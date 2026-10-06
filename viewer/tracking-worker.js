// Module worker; nothing is downloaded until Camera is enabled.
const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
let landmarker = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const { FaceLandmarker, FilesetResolver } = await import(`${CDN}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      // This MediaPipe version loads WASM glue with importScripts, unavailable in
      // module workers. Import the glue as a module and provide its factory instead.
      const response = await fetch(fileset.wasmLoaderPath);
      if (!response.ok) throw new Error(`WASM loader: HTTP ${response.status}`);
      const loaderUrl = URL.createObjectURL(new Blob([
        await response.text(), '\nexport default ModuleFactory;',
      ], { type: 'text/javascript' }));
      try {
        self.ModuleFactory = (await import(loaderUrl)).default;
      } finally {
        URL.revokeObjectURL(loaderUrl);
      }
      landmarker = await FaceLandmarker.createFromOptions({ ...fileset, wasmLoaderPath: undefined }, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'CPU',
        },
        runningMode: 'VIDEO', numFaces: 1,
        outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'frame') {
      try {
        const result = landmarker.detectForVideo(data.bitmap, data.timestamp);
        self.postMessage({ type: 'result',
          blends: result.faceBlendshapes[0]?.categories || [],
          matrix: result.facialTransformationMatrixes[0]?.data || null,
          found: result.faceLandmarks.length > 0,
        });
      } finally {
        data.bitmap.close();
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
