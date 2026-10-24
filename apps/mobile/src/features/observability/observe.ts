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

/**
 * While sending is off, each dispatch pass drops the reports it finds. One
 * recorded after the last pass would still go out once sending resumes, so a
 * pass runs before sending is turned back on.
 */
export async function setCrashReportsEnabled(enabled: boolean) {
  const dispatchingEnabled = crashReportingAvailable && enabled;
  if (dispatchingEnabled) await Observe.dispatchEvents();
  Observe.configure({
    dispatchingEnabled,
    ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
  });
}

if (!crashReportingAvailable) {
  void setCrashReportsEnabled(false);
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
