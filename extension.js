import GLib from "gi://GLib";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import {
  QuickMenuToggle,
  SystemIndicator,
} from "resource:///org/gnome/shell/ui/quickSettings.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const PERF_PROFILE_PARAMS = {
  Quiet: {
    name: "Quiet",
    iconName: "power-profile-power-saver-symbolic",
  },
  Balanced: {
    name: "Balanced",
    iconName: "power-profile-balanced-symbolic",
  },
  Performance: {
    name: "Performance",
    iconName: "power-profile-performance-symbolic",
  },
};

const RETRY_DELAY = 1000;
const MAX_RETRIES = 3;

// DBus config - discovered via: busctl --system list | grep asus
// Interface tree: gdbus introspect --system --dest xyz.ljones.Asusd --object-path /
const DBUS_NAME = "xyz.ljones.Asusd";
const DBUS_PATH = "/xyz/ljones";
const DBUS_INTERFACE = "xyz.ljones.Platform";

// Profile value mapping - confirmed by switching profiles and reading PlatformProfile
const PROFILE_VALUE_MAP = {
  0: "Balanced",
  1: "Performance",
  2: "Quiet",
};

// Reverse mapping: profile name to DBus value
const PROFILE_NAME_TO_VALUE = {
  "Balanced": 0,
  "Performance": 1,
  "Quiet": 2,
};

const PerfProfilesToggle = GObject.registerClass(
  {
    Properties: {
      "active-profile": GObject.ParamSpec.string(
        "active-profile",
        "Active Profile",
        "The currently active Perf profile",
        GObject.ParamFlags.READWRITE,
        null
      ),
    },
  },
  class PerfProfilesToggle extends QuickMenuToggle {
    _init() {
      super._init({ title: "Perf Mode" });

      this._profileItems = new Map();
      this._activeProfile = null;
      this._retryTimeoutId = null;
      this.connect("clicked", () => {
        this._sync();
      });

      this._profileSection = new PopupMenu.PopupMenuSection();
      this.menu.addMenuItem(this._profileSection);
      this.menu.setHeader("preferences-system-symbolic", "Perf Mode");
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      this._fetchSupportedProfiles();
      this._subscribeToDBus();
    }

    _subscribeToDBus() {
      this._dbusConnection = Gio.DBus.system;
      this._signalId = this._dbusConnection.signal_subscribe(
        DBUS_NAME,
        "org.freedesktop.DBus.Properties",
        "PropertiesChanged",
        DBUS_PATH,
        null,
        Gio.DBusSignalFlags.NONE,
        (connection, senderName, objectPath, interfaceName, signalName, parameters) => {
          let [iface, changedProps] = parameters.deep_unpack();
          if (iface !== DBUS_INTERFACE) return;

          if ("PlatformProfile" in changedProps) {
            let newProfileValue = changedProps["PlatformProfile"].deep_unpack();
            let newProfile = PROFILE_VALUE_MAP[newProfileValue];
            if (newProfile) {
              this._setActiveProfile(newProfile);
            }
          }
        }
      );
    }

    _fetchSupportedProfiles() {
      this._executeCommandWithRetry(
        ["asusctl", "profile", "-l"],
        (stdout) => {
          const supportedProfiles = this._parseSupportedProfiles(stdout);
          this._addProfileToggles(supportedProfiles);
          this._fetchCurrentProfile();
        },
        () => {
          console.error("Failed to fetch supported profiles after multiple attempts");
          this._addProfileToggles(Object.keys(PERF_PROFILE_PARAMS));
          this._fetchCurrentProfile();
        }
      );
    }

    _parseSupportedProfiles(output) {
      try {
        const lines = output.trim().split("\n");
        return lines
          .filter(line => {
            const trimmed = line.trim();
            return trimmed && !trimmed.startsWith("Starting version");
          })
          .map(line => line.trim());
      } catch (e) {
        console.error(`Error parsing supported profiles: ${e.message}`);
        return Object.keys(PERF_PROFILE_PARAMS);
      }
    }

    _fetchCurrentProfile() {
      this._executeCommandWithRetry(
        ["asusctl", "profile", "-p"],
        (stdout) => {
          const profile = this._parseCurrentProfile(stdout);
          if (profile && profile in PERF_PROFILE_PARAMS) {
            this._setActiveProfile(profile);
          } else {
            console.error(`Unknown profile returned: ${profile}`);
            this._setActiveProfile("Balanced");
          }
        },
        () => {
          console.error("Failed to fetch current profile after multiple attempts");
          this._setActiveProfile("Balanced");
        }
      );
    }

    _parseCurrentProfile(output) {
      try {
        const lines = output.trim().split("\n");
        for (const line of lines) {
          const match = line.match(/^Active profile is (\w+)/);
          if (match) {
            return match[1];
          }
        }
        console.error("Could not find 'Active profile is' in output");
        return null;
      } catch (e) {
        console.error(`Error parsing current profile: ${e.message}`);
        return null;
      }
    }

    _executeCommandWithRetry(command, onSuccess, onFailure, retryCount = 0) {
      try {
        let proc = Gio.Subprocess.new(
          command,
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );

        proc.communicate_utf8_async(null, null, (proc, res) => {
          try {
            let [ok, stdout, stderr] = proc.communicate_utf8_finish(res);
            if (ok) {
              onSuccess(stdout);
            } else if (retryCount < MAX_RETRIES) {
              this._retryTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                RETRY_DELAY,
                () => {
                  this._executeCommandWithRetry(
                    command,
                    onSuccess,
                    onFailure,
                    retryCount + 1
                  );
                  this._retryTimeoutId = null;
                  return GLib.SOURCE_REMOVE;
                }
              );
            } else {
              console.error(`Command failed after ${MAX_RETRIES} attempts: ${stderr}`);
              onFailure();
            }
          } catch (e) {
            console.error(`Error in command execution: ${e.message}`);
            onFailure();
          }
        });
      } catch (e) {
        console.error(`Failed to execute command: ${e.message}`);
        onFailure();
      }
    }

    _clearRetryTimeout() {
      if (this._retryTimeoutId !== null) {
        GLib.source_remove(this._retryTimeoutId);
        this._retryTimeoutId = null;
      }
    }

    _addProfileToggles(supportedProfiles) {
      for (const profile of supportedProfiles) {
        if (PERF_PROFILE_PARAMS[profile]) {
          const params = PERF_PROFILE_PARAMS[profile];
          const item = new PopupMenu.PopupImageMenuItem(
            params.name,
            params.iconName
          );
          item.connect("activate", () => {
            this._activateProfile(profile);
          });
          this._profileItems.set(profile, item);
          this._profileSection.addMenuItem(item);
        }
      }
    }

    _activateProfile(profile) {
      if (profile === this._activeProfile) {
        return;
      }

      const profileValue = PROFILE_NAME_TO_VALUE[profile];
      if (profileValue === undefined) {
        console.error(`Unknown profile: ${profile}`);
        return;
      }

      // Use DBus to set PlatformProfile property
      this._dbusConnection.call(
        DBUS_NAME,
        DBUS_PATH,
        "org.freedesktop.DBus.Properties",
        "Set",
        new GLib.Variant("(ssv)", [
          DBUS_INTERFACE,
          "PlatformProfile",
          new GLib.Variant("u", profileValue)
        ]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (connection, res) => {
          try {
            connection.call_finish(res);
          } catch (e) {
            console.error(`Failed to set profile via DBus: ${e.message}`);
            Main.notify(
              "Perf Switcher",
              `Failed to switch to ${profile} profile. Please try again or check system logs.`
            );
          }
        }
      );
    }

    _setActiveProfile(profile) {
      if (PERF_PROFILE_PARAMS[profile]) {
        this._activeProfile = profile;
        this.notify("active-profile");
        this._sync();
      } else {
        console.error(`Unknown profile: ${profile}`);
      }
    }

    get activeProfile() {
      return this._activeProfile;
    }

    _sync() {
      const params = PERF_PROFILE_PARAMS[this._activeProfile];
      if (!params) {
        return;
      }

      for (const [profile, item] of this._profileItems) {
        item.setOrnament(
          profile === this._activeProfile
            ? PopupMenu.Ornament.CHECK
            : PopupMenu.Ornament.NONE
        );
      }

      this.set({ subtitle: params.name, iconName: params.iconName });
      this.checked = this._activeProfile !== "Balanced";
    }

    destroy() {
      if (this._signalId) {
        this._dbusConnection.signal_unsubscribe(this._signalId);
        this._signalId = null;
      }
      this._clearRetryTimeout();
      this._profileItems.clear();
      super.destroy();
    }
  }
);

export const Indicator = GObject.registerClass(
  class Indicator extends SystemIndicator {
    _init() {
      super._init();

      this._indicator = this._addIndicator();
      this._indicator.icon_name = "power-profile-balanced-symbolic";
      this.indicatorIndex = 0;

      this._toggle = new PerfProfilesToggle();
      this.quickSettingsItems.push(this._toggle);

      this._toggle.connect(
        "notify::active-profile",
        this._updateIcon.bind(this)
      );

      this._insertIndicator();
      this._updateIcon();
    }

    _insertIndicator() {
      const QuickSettingsMenu = Main.panel.statusArea.quickSettings;
      if (QuickSettingsMenu && QuickSettingsMenu._indicators) {
        QuickSettingsMenu._indicators.insert_child_at_index(
          this,
          this.indicatorIndex
        );
      }
    }

    _updateIcon() {
      const activeProfile = this._toggle.activeProfile;
      if (activeProfile && PERF_PROFILE_PARAMS[activeProfile]) {
        const params = PERF_PROFILE_PARAMS[activeProfile];
        this._indicator.icon_name = params.iconName;
        this._indicator.visible = true;
      } else {
        this._indicator.icon_name = "power-profile-balanced-symbolic";
        this._indicator.visible = true;
      }
    }

    destroy() {
      this._toggle?.destroy();
      super.destroy();
    }
  }
);

export default class PerfSwitcherExtension extends Extension {
  enable() {
    this._indicator = new Indicator();
    Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
  }

  disable() {
    if (this._indicator) {
      this._indicator.quickSettingsItems.forEach((item) => {
        item.destroy();
      });
      const parent = this._indicator.get_parent();
      if (parent) {
        parent.remove_child(this._indicator);
      }
      this._indicator.destroy();
      this._indicator = null;
    }
  }
}