import Constants from "expo-constants";
import { Observe } from "expo-observe";

/**
 * Importing expo-observe installs its handler for unhandled JavaScript errors,
 * and its native side records crashes. Reports leave the device only when the
 * build points Observe at the relay; without that (forks, local builds with no
 * relay configured) Observe would fall back to Expo's own ingest under this
 * app's EAS project, so dispatching stays off.
 */
const endpointUrl: unknown = Constants.expoConfig?.extra?.eas?.observe?.endpointUrl;
const appVariant: unknown = Constants.expoConfig?.extra?.appVariant;

/** Whether this build has anywhere to send crash reports. */
export const crashReportingAvailable = typeof endpointUrl === "string";

/** While sending is off, Observe drops reports rather than holding them for later. */
export function setCrashReportsEnabled(enabled: boolean) {
  Observe.configure({
    dispatchingEnabled: crashReportingAvailable && enabled,
    ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
  });
}

if (!crashReportingAvailable) {
  setCrashReportsEnabled(false);
} else {
  // Observe keeps its last configuration across launches, so until the setting
  // loads the previous session's choice applies. Turning sending off in the
  // meantime would drop reports, including the last session's native crash.
  // Loaded after startup: the persistence runtime's module graph must not run
  // ahead of the imports `index.ts` orders first.
  void import("../../persistence/imperative")
    .then(({ loadPreferences }) => loadPreferences())
    .then((preferences) => setCrashReportsEnabled(preferences.crashReportsEnabled !== false))
    .catch((error: unknown) => {
      console.warn("[observe] could not read the crash report setting", error);
    });
}
