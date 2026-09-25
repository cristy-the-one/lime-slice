export interface PrinterProfile {
  name: string;
  nozzleDiameter: number;
  filamentDiameter: number;
  nozzleTemp: number;
  bedTemp: number;
  bedX: number;
  bedY: number;
  bedZ: number;
  maxVolumetricMm3S: number;
  maxAccel: number;
  filamentDensityGCm3: number;
  filamentCostPerKg: number;
  pressureAdvance: number;
  linearAdvance: number;
}

const KEY = "lime-slice.profile.v1";

export function defaultProfile(): PrinterProfile {
  return {
    name: "Generic Marlin 0.4 mm PLA",
    nozzleDiameter: 0.4,
    filamentDiameter: 1.75,
    nozzleTemp: 200,
    bedTemp: 60,
    bedX: 220,
    bedY: 220,
    bedZ: 250,
    maxVolumetricMm3S: 12,
    maxAccel: 10000,
    filamentDensityGCm3: 1.24,
    filamentCostPerKg: 20,
    pressureAdvance: 0,
    linearAdvance: 0,
  };
}

export function loadProfile(): PrinterProfile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultProfile();
    return { ...defaultProfile(), ...JSON.parse(raw) };
  } catch {
    return defaultProfile();
  }
}

export function saveProfile(profile: PrinterProfile) {
  localStorage.setItem(KEY, JSON.stringify(profile));
}

export function profileJson(profile: PrinterProfile) {
  return JSON.stringify(profile, null, 2);
}
