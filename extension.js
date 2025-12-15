import GLib from "gi://GLib";
import Gio from "gi://Gio";
import St from "gi://St";
import GObject from "gi://GObject";
import {
  QuickMenuToggle,
  SystemIndicator,
} from "resource:///org/gnome/shell/ui/quickSettings.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as Util from "resource:///org/gnome/shell/misc/util.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const PERF_PROFILE_PARAMS = {
  Quiet: {
    name: "Quiet",
    iconName: "power-profile-power-saver-symbolic",
    command: "asusctl profile -P Quiet",
  },
  Balanced: {
    name: "Balanced",
    iconName: "power-profile-balanced-symbolic",
    command: "asusctl profile -P Balanced",
  },
  Performance: {
    name: "Performance",
    iconName: "power-profile-performance-symbolic",
    command: "asusctl profile -P Performance",
  },
};

const RETRY_DELAY = 1000;
const MAX_RETRIES = 3;

// DBus 配置 - 通过 busctl 和 gdbus introspect 发现
// busctl --system list | grep asus -> xyz.ljones.Asusd
// gdbus introspect --system --dest xyz.ljones.Asusd --object-path / -> 完整接口树
const DBUS_NAME = "xyz.ljones.Asusd";
const DBUS_PATH = "/xyz/ljones";
const DBUS_INTERFACE = "xyz.ljones.Platform";

// Profile 数值映射 - 通过切换 profile 并读取 PlatformProfile 属性值确认
// asusctl profile -P Balanced && gdbus call ... Get ... PlatformProfile -> 0
// asusctl profile -P Performance -> 1, Quiet -> 2
const PROFILE_VALUE_MAP = {
  0: "Balanced",
  1: "Performance",
  2: "Quiet",
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

      // 使用系统图标作为 header 图标
      this._profileSection = new PopupMenu.PopupMenuSection();
      this.menu.addMenuItem(this._profileSection);
      this.menu.setHeader("preferences-system-symbolic", "Perf Mode");
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      // Fetch supported and current profiles
      this._fetchSupportedProfiles();

      // Subscribe to DBus signal for Perf mode changes
      this._subscribeToDBus();
    }

    _subscribeToDBus() {
      // asusd 使用标准的 PropertiesChanged 信号而非自定义信号
      // 当 PlatformProfile 属性变化时触发
      this._dbusConnection = Gio.DBus.system;
      this._signalId = this._dbusConnection.signal_subscribe(
        DBUS_NAME,                              // 服务名: xyz.ljones.Asusd
        "org.freedesktop.DBus.Properties",      // 标准属性变化接口
        "PropertiesChanged",                    // 信号名
        DBUS_PATH,                              // 对象路径: /xyz/ljones
        null,
        Gio.DBusSignalFlags.NONE,
        (connection, senderName, objectPath, interfaceName, signalName, parameters) => {
          // PropertiesChanged 信号参数: (interface_name, changed_properties, invalidated_properties)
          let [iface, changedProps, invalidatedProps] = parameters.deep_unpack();

          // 只处理 Platform 接口的变化
          if (iface !== DBUS_INTERFACE) return;

          // 检查 PlatformProfile 是否变化
          if ("PlatformProfile" in changedProps) {
            let newProfileValue = changedProps["PlatformProfile"].deep_unpack();
            let newProfile = PROFILE_VALUE_MAP[newProfileValue];
            console.log(`PropertiesChanged: PlatformProfile = ${newProfileValue} (${newProfile})`);
            if (newProfile) {
              this._setActiveProfile(newProfile);
            }
          }
        }
      );
    }

    _fetchSupportedProfiles() {
      // asusctl profile -l 输出格式:
      // Starting version 6.2.0
      // Quiet
      // Balanced
      // Performance
      this._executeCommandWithRetry(
        ["asusctl", "profile", "-l"],
        (stdout) => {
          const supportedProfiles = this._parseSupportedProfiles(stdout);
          this._addProfileToggles(supportedProfiles);
          this._fetchCurrentProfile();
        },
        () => {
          console.error(
            "Failed to fetch supported profiles after multiple attempts"
          );
          // Fallback: use all defined profiles.
          this._addProfileToggles(Object.keys(PERF_PROFILE_PARAMS));
          this._fetchCurrentProfile();
        }
      );
    }

    _parseSupportedProfiles(output) {
      try {
        // 输出格式: 每行一个 profile，第一行是版本信息
        // Starting version 6.2.0
        // Quiet
        // Balanced
        // Performance
        const lines = output.trim().split("\n");
        // 过滤掉版本信息行和空行，只保留有效的 profile 名称
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
      // asusctl profile -p 输出格式:
      // Starting version 6.2.0
      // Active profile is Quiet
      // Profile on AC is Performance
      // Profile on Battery is Quiet
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
          console.error(
            "Failed to fetch current profile after multiple attempts"
          );
          this._setActiveProfile("Balanced");
        }
      );
    }

    _parseCurrentProfile(output) {
      try {
        // 查找 "Active profile is XXX" 这一行
        const lines = output.trim().split("\n");
        for (const line of lines) {
          const match = line.match(/^Active profile is (\w+)/);
          if (match) {
            return match[1]; // 返回 profile 名称
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
              console.log(`Command failed, retrying in ${RETRY_DELAY}ms...`);
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
            console.log(`Activating profile: ${profile}`);
            this._activateProfile(profile, params.command);
          });
          this._profileItems.set(profile, item);
          this._profileSection.addMenuItem(item);
        }
      }
    }

    _activateProfile(profile, command) {
      if (profile === this._activeProfile) {
        console.log(`Profile ${profile} is already active. Skipping activation.`);
        return;
      }
      //
      // if (
      //   (profile === "Performance" && this._activeProfile === "Balanced") ||
      //   (profile === "Balanced" && this._activeProfile === "Performance")
      // ) {
      //   console.error(
      //     "Direct switching between Vfio and Balanced profiles is not supported."
      //   );
      //   Main.notify(
      //     "Perf Switcher",
      //     "Direct switching between Vfio and Balanced profiles is not supported. Please switch to Integrated first."
      //   );
      //   return;
      // }

      this._executeCommandWithRetry(
        ["sh", "-c", command],
        () => {
          console.log(`Profile ${profile} activated successfully`);
          const previousProfile = this._activeProfile;
          this._setActiveProfile(profile);
          // if (
          //   (previousProfile === "Integrated" && profile === "Balanced") ||
          //   (previousProfile === "Balanced" && profile === "Integrated")
          // ) {
          //   Util.spawnCommandLine("gnome-session-quit --logout");
          // }
        },
        () => {
          console.error(`Failed to activate profile ${profile} after multiple attempts`);
          Main.notify(
            "Perf Switcher",
            `Failed to switch to ${profile} profile. Please try again or check system logs.`
          );
        }
      );
    }

    _setActiveProfile(profile) {
      if (PERF_PROFILE_PARAMS[profile]) {
        console.log(`Setting active profile: ${profile}`);
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
      console.log(`Synchronizing profile: ${this._activeProfile}`);

      const params = PERF_PROFILE_PARAMS[this._activeProfile];
      if (!params) {
        console.error(
          `Active profile ${this._activeProfile} is not defined in PERF_PROFILE_PARAMS.`
        );
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
      super.destroy();
    }
  }
);

export const Indicator = GObject.registerClass(
  class Indicator extends SystemIndicator {
    _init() {
      super._init();

      this._indicator = this._addIndicator();
      this._indicator.icon_name = "power-profile-balanced-symbolic"; // Default icon
      this.indicatorIndex = 0;

      // Create the quick settings toggle
      this._toggle = new PerfProfilesToggle();
      this.quickSettingsItems.push(this._toggle);

      this._toggle.connect(
        "notify::active-profile",
        this._updateIcon.bind(this)
      );

      // Insert the indicator into quick settings
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
      } else {
        console.warn("Unable to insert indicator at specific index");
      }
    }

    _updateIcon() {
      const activeProfile = this._toggle.activeProfile;
      if (activeProfile && PERF_PROFILE_PARAMS[activeProfile]) {
        const params = PERF_PROFILE_PARAMS[activeProfile];
        this._indicator.icon_name = params.iconName;
        this._indicator.visible = true;
      } else {
        this._indicator.icon_name = "video-display-symbolic"; // Default icon
        this._indicator.visible = true;
      }
      console.log(`Updated icon: ${this._indicator.icon_name}, Visible: ${this._indicator.visible}`);
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
