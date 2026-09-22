import {
  UNENROLLED_ANDROID_DEVICE_HOST,
  type AndroidDeviceHostEnrollment,
} from "@t3tools/client-runtime/android-device-host";
import { useCallback, useEffect, useState } from "react";

import { loadDeviceHostEnrollment, saveDeviceHostEnrollment } from "./deviceHostEnrollmentStorage";

export function useDeviceHostEnrollment() {
  const [enrollment, setEnrollment] = useState<AndroidDeviceHostEnrollment>(
    UNENROLLED_ANDROID_DEVICE_HOST,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void loadDeviceHostEnrollment().then((loaded) => {
      if (!active) return;
      setEnrollment(loaded);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const update = useCallback(async (next: AndroidDeviceHostEnrollment) => {
    setEnrollment(next);
    await saveDeviceHostEnrollment(next);
  }, []);

  return { enrollment, loading, update };
}
