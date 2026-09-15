import { fetchSyncPost, Plugin, Protyle, Setting, showMessage } from "siyuan";
import amapCities from "./data/amap-cities.json";

const STATUS_ITEM_ID = "weather-status";
const STORAGE_NAME = "weather-config";
const ICON_ASSET_STORAGE = "weather-icon-assets";
const WEATHER_API_ENDPOINT =
  "https://restapi.amap.com/v3/weather/weatherInfo";
const REFRESH_INTERVAL_OPTIONS = [5, 10, 30, 60];
const CITY_RESULT_LIMIT = 20;
const SETTING_WIDTH = "960px";
const SETTING_CONTROL_WIDTH = "260px";
const DEFAULT_CONFIG: WeatherConfig = {
  key: "",
  city: "",
  intervalMinutes: 10,
  showIcon: true
};

// 高德天气文字 -> icons/ 下的图标文件名（不含扩展名）
// 归并规则见 doc/天气枚举图标映射表.md，查不到时回退 unknown
const WEATHER_ICON_MAP: Record<string, string> = {
  晴: "sunny",
  少云: "few-clouds",
  晴间多云: "partly-cloudy",
  多云: "cloudy",
  阴: "overcast",
  有风: "wind",
  平静: "wind",
  微风: "wind",
  和风: "wind",
  清风: "wind",
  "强风/劲风": "wind",
  强风: "wind",
  劲风: "wind",
  疾风: "wind",
  大风: "wind",
  烈风: "wind",
  风暴: "wind",
  狂爆风: "wind",
  飓风: "wind",
  热带风暴: "wind",
  霾: "haze",
  中度霾: "haze",
  重度霾: "haze",
  严重霾: "haze",
  阵雨: "shower",
  强阵雨: "shower",
  雷阵雨: "thunderstorm",
  强雷阵雨: "thunderstorm",
  雷阵雨并伴有冰雹: "hail",
  小雨: "light-rain",
  中雨: "moderate-rain",
  雨: "moderate-rain",
  "小雨-中雨": "moderate-rain",
  大雨: "heavy-rain",
  "中雨-大雨": "heavy-rain",
  暴雨: "rainstorm",
  大暴雨: "rainstorm",
  特大暴雨: "rainstorm",
  极端降雨: "rainstorm",
  "大雨-暴雨": "rainstorm",
  "暴雨-大暴雨": "rainstorm",
  "大暴雨-特大暴雨": "rainstorm",
  "毛毛雨/细雨": "drizzle",
  毛毛雨: "drizzle",
  细雨: "drizzle",
  雨雪天气: "sleet",
  雨夹雪: "sleet",
  阵雨夹雪: "sleet",
  冻雨: "freezing-rain",
  阵雪: "snow-shower",
  小雪: "light-snow",
  中雪: "snow",
  雪: "snow",
  "小雪-中雪": "snow",
  大雪: "heavy-snow",
  "中雪-大雪": "heavy-snow",
  暴雪: "snowstorm",
  "大雪-暴雪": "snowstorm",
  浮尘: "dust",
  扬沙: "dust",
  沙尘暴: "sandstorm",
  强沙尘暴: "sandstorm",
  龙卷风: "tornado",
  雾: "fog",
  浓雾: "fog",
  强浓雾: "fog",
  轻雾: "fog",
  大雾: "fog",
  特强浓雾: "fog",
  热: "hot",
  冷: "cold",
  未知: "unknown"
};

type AmapCityRecord = [name: string, adcode: string, parentAdcode: string | null];

interface AmapCity {
  name: string;
  adcode: string;
  parentAdcode: string | null;
  path: string;
}

interface WeatherConfig {
  key: string;
  city: string;
  intervalMinutes: number;
  showIcon: boolean;
}

interface AmapWeatherResponse {
  status: string;
  info?: string;
  lives?: Array<{
    weather?: string;
    temperature?: string;
    humidity?: string;
    winddirection?: string;
    windpower?: string;
  }>;
}

interface WeatherSnapshot {
  weather: string;
  temperature: string;
  humidity: string;
  winddirection: string;
  windpower: string;
}

function createCities(records: AmapCityRecord[]): AmapCity[] {
  const recordsByAdcode = new Map(
    records.map(([name, adcode, parentAdcode]) => [
      adcode,
      { name, adcode, parentAdcode }
    ])
  );
  const pathsByAdcode = new Map<string, string>();

  const resolvePath = (adcode: string, visiting = new Set<string>()): string => {
    const cachedPath = pathsByAdcode.get(adcode);
    if (cachedPath) {
      return cachedPath;
    }
    if (visiting.has(adcode)) {
      throw new Error(`城市数据存在父级循环：${adcode}`);
    }

    const record = recordsByAdcode.get(adcode);
    if (!record) {
      throw new Error(`城市数据缺少父级：${adcode}`);
    }

    visiting.add(adcode);
    const path = record.parentAdcode
      ? `${resolvePath(record.parentAdcode, visiting)} / ${record.name}`
      : record.name;
    visiting.delete(adcode);
    pathsByAdcode.set(adcode, path);
    return path;
  };

  return records.map(([name, adcode, parentAdcode]) => ({
    name,
    adcode,
    parentAdcode,
    path: resolvePath(adcode)
  }));
}

export default class WeatherPlugin extends Plugin {
  private config: WeatherConfig = { ...DEFAULT_CONFIG };
  private statusItem?: HTMLButtonElement;
  private refreshTimer?: number;
  private isRefreshing = false;
  private lastWeather = "";
  private lastSnapshot?: WeatherSnapshot;
  private iconAssetMap: Record<string, string> = {};
  private iconAssetsLoaded = false;
  private keyInput!: HTMLInputElement;
  private citySearchInput!: HTMLInputElement;
  private cityPicker!: HTMLElement;
  private cityResultList!: HTMLElement;
  private selectedCity?: AmapCity;
  private intervalSelect!: HTMLSelectElement;
  private showIconInput!: HTMLInputElement;
  private refreshButton!: HTMLButtonElement;
  private readonly repositionCityResults = (): void => {
    if (this.cityResultList?.style.display !== "none") {
      this.positionCityResults();
    }
  };
  private readonly handleCityPickerOutsideClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }

    if (
      !this.cityPicker.contains(target) &&
      !this.cityResultList.contains(target)
    ) {
      this.hideCityResults();
    }
  };
  private readonly cities: AmapCity[] = createCities(
    amapCities as AmapCityRecord[]
  );
  private readonly citiesByAdcode = new Map(
    this.cities.map((city) => [city.adcode, city])
  );

  onload(): void {
    this.createSetting();
    this.protyleSlash = [
      {
        filter: ["天气", "weather", "tq"],
        html: `<div class="b3-list-item__first"><span class="b3-list-item__text">${this.t(
          "slash.weather",
          "Weather"
        )}</span></div>`,
        id: "insertWeather",
        callback: (protyle) => {
          void this.insertWeatherIntoDoc(protyle, false);
        }
      },
      {
        filter: ["天气详细", "天气(详细)", "weather detail", "tqxx"],
        html: `<div class="b3-list-item__first"><span class="b3-list-item__text">${this.t(
          "slash.weatherDetail",
          "Weather (detail)"
        )}</span></div>`,
        id: "insertWeatherDetail",
        callback: (protyle) => {
          void this.insertWeatherIntoDoc(protyle, true);
        }
      }
    ];
  }

  onDataChanged(): void {}

  async onLayoutReady(): Promise<void> {
    await this.loadConfig();
    this.updateSettingFields();
    this.createStatusItem();
    this.addTopBar({
      icon: "iconSettings",
      title: this.t("topbar.settings", "Weather settings"),
      position: "right",
      callback: () => {
        this.openSetting();
      }
    });

    this.startAutoRefresh();
    if (this.hasValidConfig()) {
      void this.refreshWeather(false);
    } else {
      this.setStatus(
        this.t("status.unconfigured", "Weather not configured"),
        this.t(
          "status.unconfiguredTip",
          "Weather is not configured. Click to open settings."
        )
      );
    }
  }

  onunload(): void {
    this.stopAutoRefresh();
    window.removeEventListener("resize", this.repositionCityResults);
    document.removeEventListener(
      "scroll",
      this.repositionCityResults,
      true
    );
    document.removeEventListener(
      "mousedown",
      this.handleCityPickerOutsideClick,
      true
    );
    this.cityResultList?.remove();
    document.getElementById(STATUS_ITEM_ID)?.remove();
  }

  private t(
    key: string,
    fallback: string,
    variables: Record<string, string | number> = {}
  ): string {
    let text = this.i18n?.[key] || fallback;
    Object.entries(variables).forEach(([name, value]) => {
      text = text.split(`{${name}}`).join(String(value));
    });
    return text;
  }

  private createSetting(): void {
    this.keyInput = document.createElement("input");
    this.keyInput.className =
      "b3-text-field fn__block weather-setting-control";
    this.keyInput.type = "password";
    this.keyInput.autocomplete = "off";
    this.keyInput.placeholder = this.t(
      "settings.apiKey.placeholder",
      "Enter Amap Web Service API Key"
    );
    // flex / margin-top 用内联写死，确保覆盖思源 v3.8.3 对 .config-item
    // 直系子控件强制的 `flex:1 1 100%; margin-top:8px`（见 index.css 说明）
    this.keyInput.style.cssText =
      `width:${SETTING_CONTROL_WIDTH};max-width:100%;box-sizing:border-box;` +
      "flex:0 1 auto;margin-top:0;";

    this.cityPicker = document.createElement("div");
    this.cityPicker.className = "weather-setting-control";
    this.cityPicker.style.cssText =
      `position:relative;width:${SETTING_CONTROL_WIDTH};max-width:100%;min-width:0;` +
      "flex:0 1 auto;margin-top:0;";

    const cityInputWrapper = document.createElement("div");
    cityInputWrapper.className = "fn__flex";
    cityInputWrapper.style.cssText = "position:relative;width:100%;";

    this.citySearchInput = document.createElement("input");
    this.citySearchInput.className = "b3-text-field fn__block";
    this.citySearchInput.type = "text";
    this.citySearchInput.autocomplete = "off";
    this.citySearchInput.placeholder = this.t(
      "settings.city.placeholder",
      "Search city or district name"
    );
    this.citySearchInput.style.cssText =
      "display:block;width:100%;min-width:0;padding-right:36px;box-sizing:border-box;";
    this.citySearchInput.addEventListener("input", () => {
      if (this.selectedCity?.path !== this.citySearchInput.value) {
        this.selectedCity = undefined;
      }
      this.renderCityResults(this.citySearchInput.value);
      this.updateCityClearButton();
    });
    this.citySearchInput.addEventListener("focus", () => {
      if (this.selectedCity?.path === this.citySearchInput.value) {
        this.citySearchInput.select();
        this.hideCityResults();
        return;
      }
      this.renderCityResults(this.citySearchInput.value);
    });

    const clearCityButton = document.createElement("button");
    clearCityButton.className = "b3-button b3-button--text fn__flex-center";
    clearCityButton.type = "button";
    const clearCityLabel = this.t(
      "actions.clearCity",
      "Clear city selection"
    );
    clearCityButton.title = clearCityLabel;
    clearCityButton.setAttribute("aria-label", clearCityLabel);
    clearCityButton.style.cssText =
      "display:none;position:absolute;right:4px;top:50%;width:28px;height:28px;padding:0;transform:translateY(-50%);";
    clearCityButton.innerHTML =
      '<svg class="b3-button__icon"><use xlink:href="#iconClose"></use></svg>';
    clearCityButton.addEventListener("click", () => {
      this.selectedCity = undefined;
      this.citySearchInput.value = "";
      this.renderCityResults("");
      this.updateCityClearButton();
      this.citySearchInput.focus();
    });
    cityInputWrapper.append(this.citySearchInput, clearCityButton);

    this.cityResultList = document.createElement("div");
    this.cityResultList.className = "b3-list b3-list--background";
    this.cityResultList.style.cssText =
      "display:none;position:fixed;z-index:10000;max-height:240px;overflow-y:auto;background:var(--b3-theme-background);box-shadow:var(--b3-point-shadow);box-sizing:border-box;";

    this.cityPicker.appendChild(cityInputWrapper);
    document.body.appendChild(this.cityResultList);
    window.addEventListener("resize", this.repositionCityResults);
    document.addEventListener("scroll", this.repositionCityResults, true);
    document.addEventListener(
      "mousedown",
      this.handleCityPickerOutsideClick,
      true
    );

    this.intervalSelect = document.createElement("select");
    this.intervalSelect.className =
      "b3-select fn__block weather-setting-control";
    this.intervalSelect.style.cssText =
      `width:${SETTING_CONTROL_WIDTH};max-width:100%;box-sizing:border-box;` +
      "flex:0 1 auto;margin-top:0;";
    REFRESH_INTERVAL_OPTIONS.forEach((minutes) => {
      const option = document.createElement("option");
      option.value = String(minutes);
      option.textContent = this.t(
        "settings.interval.optionMinutes",
        "{minutes} minutes",
        { minutes }
      );
      this.intervalSelect.appendChild(option);
    });

    this.showIconInput = document.createElement("input");
    // 也带 weather-setting-control：开关本身不受思源窄屏规则影响，
    // 加这个类是为了让 index.css 的反制选择器能定位到「本插件的这个设置项」
    this.showIconInput.className =
      "b3-switch fn__flex-center weather-setting-control";
    this.showIconInput.type = "checkbox";

    this.refreshButton = document.createElement("button");
    this.refreshButton.className =
      "b3-button b3-button--outline fn__flex-center weather-setting-control";
    this.refreshButton.type = "button";
    // width:auto 覆盖思源追加的 .fn__size200(200px)，按钮按内容自适应
    this.refreshButton.style.cssText = "width:auto;flex:0 1 auto;margin-top:0;";
    this.refreshButton.innerHTML =
      `<svg class="b3-button__icon"><use xlink:href="#iconRefresh"></use></svg><span>${this.t(
        "actions.refresh",
        "Refresh now"
      )}</span>`;
    this.refreshButton.addEventListener("click", () => {
      void this.refreshWeather(true, this.getFormConfig());
    });

    this.setting = new Setting({
      width: SETTING_WIDTH,
      destroyCallback: () => {
        this.hideCityResults();
      },
      confirmCallback: () => {
        void this.saveConfig();
      }
    });
    this.setting.addItem({
      title: this.t("settings.apiKey.title", "Amap API Key"),
      direction: "column",
      description: this.t(
        "settings.apiKey.description",
        'The Amap Web Service API key used for weather requests. <a href="https://www.showdoc.com.cn/siyuanPluginWeather/11559060627523622" target="_blank" rel="noopener noreferrer">View guide</a>'
      ),
      // 控件带 weather-setting-control 类：index.css 用它圈定「本插件的设置项」，
      // 用于反制第三方插件泄漏的全局样式，并修正思源 v3.8.3 的窄屏规则，详见 index.css
      actionElement: this.keyInput
    });
    this.setting.addItem({
      title: this.t("settings.city.title", "Weather city"),
      direction: "column",
      description: this.t(
        "settings.city.description",
        "Choose a district or a higher-level area. Towns, streets, and smaller areas are not supported."
      ),
      actionElement: this.cityPicker
    });
    this.setting.addItem({
      title: this.t("settings.interval.title", "Auto refresh interval"),
      direction: "column",
      description: this.t(
        "settings.interval.description",
        "Set how often the weather service is requested automatically."
      ),
      actionElement: this.intervalSelect
    });
    this.setting.addItem({
      title: this.t("settings.showIcon.title", "Show weather icon"),
      description: this.t(
        "settings.showIcon.description",
        "Show a weather icon to the left of the weather text in the status bar."
      ),
      // 开关保持直系子元素、不包 wrapper：思源靠 actionElement 是否带 b3-switch 类
      // 决定容器渲染成 <label>（点整行可切换），包一层会丢掉这个语义。
      // 它带 weather-setting-control 类，仅用于让 index.css 的反制选择器定位到本设置项。
      actionElement: this.showIconInput
    });
    this.setting.addItem({
      title: this.t("settings.manual.title", "Manual refresh"),
      description: this.t(
        "settings.manual.description",
        "Request the latest weather now."
      ),
      actionElement: this.refreshButton
    });
  }

  private async loadConfig(): Promise<void> {
    try {
      const savedConfig = (await this.loadData(STORAGE_NAME)) as
        | Partial<WeatherConfig>
        | undefined;

      if (!savedConfig || typeof savedConfig !== "object") {
        return;
      }

      this.config = {
        key: typeof savedConfig.key === "string" ? savedConfig.key.trim() : "",
        city:
          typeof savedConfig.city === "string" &&
          this.citiesByAdcode.has(savedConfig.city.trim())
            ? savedConfig.city.trim()
            : "",
        intervalMinutes: this.normalizeInterval(savedConfig.intervalMinutes),
        showIcon:
          typeof savedConfig.showIcon === "boolean"
            ? savedConfig.showIcon
            : true
      };
    } catch (error) {
      console.error(`[${this.name}] 加载天气配置失败`, error);
    }
  }

  private async saveConfig(): Promise<void> {
    this.config = this.getFormConfig();
    this.clearWeather();

    try {
      await this.saveData(STORAGE_NAME, this.config);
      this.updateSettingFields();
      this.startAutoRefresh();
      if (this.hasValidConfig()) {
        await this.refreshWeather(true, this.config);
      }
    } catch (error) {
      console.error(`[${this.name}] 保存天气配置失败`, error);
      showMessage(
        this.t(
          "messages.configSaveFailed",
          "Failed to save weather settings."
        ),
        5000,
        "error"
      );
    }
  }

  private updateSettingFields(): void {
    this.keyInput.value = this.config.key;
    this.selectedCity = this.citiesByAdcode.get(this.config.city);
    this.citySearchInput.value = this.selectedCity?.path ?? "";
    this.updateCityClearButton();
    this.hideCityResults();
    this.intervalSelect.value = String(this.config.intervalMinutes);
    this.showIconInput.checked = this.config.showIcon;
  }

  private createStatusItem(): void {
    const statusItem = document.createElement("button");
    statusItem.id = STATUS_ITEM_ID;
    statusItem.className = "b3-tooltips b3-tooltips__nw";
    statusItem.type = "button";
    statusItem.style.cssText = [
      "border: 0",
      "background: transparent",
      "color: var(--b3-theme-on-surface)",
      "cursor: pointer",
      "height: 30px",
      "padding: 0 8px",
      "font-size: 12px",
      "display: flex",
      "align-items: center",
      "gap: 4px"
    ].join(";");
    statusItem.addEventListener("click", () => {
      if (this.hasValidConfig()) {
        void this.refreshWeather(true);
      } else {
        this.openSetting();
      }
    });

    this.statusItem = statusItem;
    this.addStatusBar({ element: statusItem, position: "right" });
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();

    if (!this.hasValidConfig()) {
      return;
    }

    this.refreshTimer = window.setInterval(() => {
      void this.refreshWeather(false);
    }, this.config.intervalMinutes * 60 * 1000);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer !== undefined) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private async refreshWeather(
    showErrorMessage: boolean,
    requestConfig: Pick<WeatherConfig, "key" | "city"> = this.config
  ): Promise<void> {
    if (!requestConfig.key || !requestConfig.city) {
      this.setStatus(
        this.t("status.unconfigured", "Weather not configured"),
        this.t(
          "status.unconfiguredTip",
          "Weather is not configured. Click to open settings."
        )
      );
      if (showErrorMessage) {
        showMessage(
          this.t(
            "messages.configRequired",
            "Enter the Amap API key and select a weather city before refreshing."
          ),
          5000,
          "error"
        );
      }
      return;
    }

    if (this.isRefreshing) {
      return;
    }

    this.isRefreshing = true;
    this.setRefreshButtonState(true);

    try {
      this.setStatus(
        this.t("status.loading", "Weather loading"),
        this.t("status.loading", "Weather loading")
      );

      const requestUrl = new URL(WEATHER_API_ENDPOINT);
      requestUrl.searchParams.set("key", requestConfig.key);
      requestUrl.searchParams.set("city", requestConfig.city);
      requestUrl.searchParams.set("extensions", "base");
      requestUrl.searchParams.set("output", "JSON");

      const response = await fetch(requestUrl.toString());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as AmapWeatherResponse;
      if (data.status !== "1") {
        throw new Error(
          data.info ||
            this.t("errors.amapRequestFailed", "Amap weather request failed.")
        );
      }

      const live = data.lives?.[0];
      if (!live) {
        throw new Error(
          this.t("errors.noWeatherData", "Amap returned no weather data.")
        );
      }

      const weather = live.weather?.trim();
      if (!weather) {
        throw new Error(
          this.t("errors.noWeatherData", "Amap returned no weather data.")
        );
      }

      this.lastWeather = weather;
      const temperature = live.temperature?.trim() ?? "";
      this.lastSnapshot = {
        weather,
        temperature,
        humidity: live.humidity?.trim() ?? "",
        winddirection: live.winddirection?.trim() ?? "",
        windpower: live.windpower?.trim() ?? ""
      };
      const weatherTip = this.buildWeatherLines(this.lastSnapshot).join("\n");
      this.setStatus(weather, weatherTip, weather, temperature);
    } catch (error) {
      console.error(`[${this.name}] 获取天气失败`, error);
      this.setStatus(
        this.t("status.failed", "Weather unavailable"),
        this.t("status.failedTip", "Weather unavailable. Click to retry.")
      );

      if (showErrorMessage) {
        const message = error instanceof Error
          ? error.message
          : this.t("errors.unknown", "Unknown error.");
        showMessage(
          this.t("messages.refreshFailed", "Weather refresh failed: {message}", {
            message
          }),
          5000,
          "error"
        );
      }
    } finally {
      this.isRefreshing = false;
      this.setRefreshButtonState(false);
    }
  }

  private setStatus(
    text: string,
    label: string,
    weather?: string,
    temperature?: string
  ): void {
    if (!this.statusItem || !document.body.contains(this.statusItem)) {
      return;
    }

    this.statusItem.replaceChildren();

    if (weather && this.config.showIcon) {
      const icon = document.createElement("img");
      icon.src = this.getWeatherIconUrl(weather);
      icon.width = 18;
      icon.height = 18;
      icon.alt = "";
      icon.style.display = "block";
      this.statusItem.appendChild(icon);
    }

    const textElement = document.createElement("span");
    textElement.textContent = temperature
      ? `${text} ${temperature}°C`
      : text;
    this.statusItem.appendChild(textElement);
    this.statusItem.setAttribute("aria-label", label);
  }

  private getWeatherIconFile(weather: string): string {
    const iconName = WEATHER_ICON_MAP[weather] ?? "unknown";
    return `weather-${iconName}.png`;
  }

  private getWeatherIconUrl(weather: string): string {
    return `/plugins/${this.name}/icons/${this.getWeatherIconFile(weather)}`;
  }

  /**
   * 把插件图标复制到工作区 assets/（去重），返回可随笔记同步的 assets 路径。
   * 背景：/plugins/ 路径不参与思源同步，且被编辑器视为"网络图片"（带地球徽章）；
   * assets/ 是笔记数据的一部分，跨设备同步不丢、无徽章。
   */
  private async ensureIconAsset(iconFile: string): Promise<string> {
    if (!this.iconAssetsLoaded) {
      this.iconAssetsLoaded = true;
      try {
        const saved = await this.loadData(ICON_ASSET_STORAGE);
        if (saved && typeof saved === "object") {
          this.iconAssetMap = saved as Record<string, string>;
        }
      } catch (error) {
        console.error(`[${this.name}] 加载图标 assets 映射失败`, error);
      }
    }

    const cached = this.iconAssetMap[iconFile];
    if (cached) {
      return cached;
    }

    const pluginUrl = `/plugins/${this.name}/icons/${iconFile}`;
    const iconResponse = await fetch(pluginUrl);
    if (!iconResponse.ok) {
      throw new Error(`HTTP ${iconResponse.status}`);
    }
    const blob = await iconResponse.blob();

    const formData = new FormData();
    formData.append("assetsDirPath", "assets/");
    formData.append("file[]", new File([blob], iconFile, { type: "image/png" }));

    const uploadResult = await fetchSyncPost("/api/asset/upload", formData);
    const assetPath = (
      uploadResult?.data as { succMap?: Record<string, string> } | undefined
    )?.succMap?.[iconFile];
    if (!assetPath) {
      throw new Error(uploadResult?.msg || "upload failed");
    }

    this.iconAssetMap[iconFile] = assetPath;
    await this.saveData(ICON_ASSET_STORAGE, this.iconAssetMap);
    return assetPath;
  }

  private buildWeatherLines(snapshot: WeatherSnapshot): string[] {
    return [
      this.t("weather.weather", "Weather: {value}", {
        value: snapshot.weather
      }),
      snapshot.temperature
        ? this.t("weather.temperature", "Temperature: {value}°C", {
            value: snapshot.temperature
          })
        : "",
      snapshot.humidity
        ? this.t("weather.humidity", "Humidity: {value}%", {
            value: snapshot.humidity
          })
        : "",
      snapshot.winddirection
        ? this.t("weather.windDirection", "Wind direction: {value}", {
            value: snapshot.winddirection
          })
        : "",
      snapshot.windpower
        ? this.t("weather.windPower", "Wind power: {value}", {
            value: snapshot.windpower
          })
        : ""
    ].filter(Boolean);
  }

  private async insertWeatherIntoDoc(
    protyle: Protyle,
    detail: boolean
  ): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      showMessage(
        this.t(
          "messages.noWeatherToInsert",
          "No weather data yet. Refresh the weather in the status bar first."
        ),
        5000,
        "error"
      );
      return;
    }

    // 优先复制到 assets/（可同步、无网络图片徽章）；失败则回退插件路径（本机可见）
    let iconUrl = this.getWeatherIconUrl(snapshot.weather);
    try {
      iconUrl = await this.ensureIconAsset(
        this.getWeatherIconFile(snapshot.weather)
      );
    } catch (error) {
      console.error(`[${this.name}] 图标复制到 assets 失败，回退插件路径`, error);
    }

    // 使用思源原生图片节点结构（与编辑器内复制粘贴图片一致），
    // 直接写 <img> 会被 Lute 当作陌生 HTML 清洗掉
    const iconHtml =
      `<span data-type="img" class="img">` +
      `<span class="img__protyle"></span>` +
      `<img data-src="${iconUrl}" src="${iconUrl}" ` +
      `style="width:18px;vertical-align:-3px;" />` +
      `<span class="img__net"></span></span>`;
    const summary = `${iconHtml}${snapshot.weather}${
      snapshot.temperature ? ` ${snapshot.temperature}°C` : ""
    }`;

    if (!detail) {
      protyle.insert(summary, false);
      return;
    }

    // 详细版也用单段落行内插入（<br> 分行），不做多块插入——
    // 多块插入会替换 slash 所在段落块，导致思源事务报 "block not found"
    const lines = this.buildWeatherLines(snapshot).slice(1);
    protyle.insert([summary, ...lines].join("<br>"), false);
  }

  private clearWeather(): void {
    this.lastWeather = "";
    this.lastSnapshot = undefined;
    this.setStatus(
      this.t("status.unconfigured", "Weather not configured"),
      this.t(
        "status.unconfiguredTip",
        "Weather is not configured. Click to open settings."
      )
    );
  }

  private getFormConfig(): WeatherConfig {
    return {
      key: this.keyInput.value.trim(),
      city: this.selectedCity?.adcode ?? "",
      intervalMinutes: this.normalizeInterval(this.intervalSelect.value),
      showIcon: this.showIconInput.checked
    };
  }

  private renderCityResults(value: string): void {
    const keyword = value.trim().toLocaleLowerCase();
    this.cityResultList.replaceChildren();

    if (!keyword) {
      this.hideCityResults();
      return;
    }

    const matches = this.cities
      .filter((city) => {
        const name = city.name.toLocaleLowerCase();
        const path = city.path.toLocaleLowerCase();
        return name.includes(keyword) || path.includes(keyword);
      })
      .sort((left, right) => {
        return (
          this.getCityMatchScore(left, keyword) -
          this.getCityMatchScore(right, keyword)
        );
      })
      .slice(0, CITY_RESULT_LIMIT);

    if (matches.length === 0) {
      const emptyItem = document.createElement("div");
      emptyItem.className = "b3-list-item";
      emptyItem.textContent = this.t(
        "cities.noMatch",
        "No supported area found."
      );
      this.cityResultList.appendChild(emptyItem);
      this.cityResultList.style.display = "block";
      this.positionCityResults();
      return;
    }

    matches.forEach((city) => {
      const resultItem = document.createElement("button");
      resultItem.className = "b3-list-item";
      resultItem.type = "button";
      resultItem.style.cssText =
        "display:flex;width:100%;border:0;background:transparent;text-align:left;cursor:pointer;";

      const pathElement = document.createElement("span");
      pathElement.className = "b3-list-item__text";
      pathElement.textContent = city.path;
      resultItem.appendChild(pathElement);
      resultItem.addEventListener("click", () => {
        this.selectCity(city);
      });
      this.cityResultList.appendChild(resultItem);
    });

    this.cityResultList.style.display = "block";
    this.positionCityResults();
  }

  private getCityMatchScore(city: AmapCity, keyword: string): number {
    const name = city.name.toLocaleLowerCase();
    const path = city.path.toLocaleLowerCase();

    if (name === keyword) {
      return 0;
    }
    if (name.startsWith(keyword)) {
      return 1;
    }
    if (path.startsWith(keyword)) {
      return 2;
    }
    return 3;
  }

  private selectCity(city: AmapCity): void {
    this.selectedCity = city;
    this.citySearchInput.value = city.path;
    this.updateCityClearButton();
    this.hideCityResults();
  }

  private updateCityClearButton(): void {
    const clearButton = this.cityPicker.querySelector(
      '[aria-label="清除城市选择"]'
    ) as HTMLElement | null;
    if (clearButton) {
      clearButton.style.display = this.citySearchInput.value ? "flex" : "none";
    }
  }

  private hideCityResults(): void {
    this.cityResultList.style.display = "none";
  }

  private positionCityResults(): void {
    const inputRect = this.citySearchInput.getBoundingClientRect();
    if (!inputRect.width || !inputRect.height) {
      this.hideCityResults();
      return;
    }

    const viewportPadding = 8;
    const width = Math.min(
      inputRect.width,
      Math.max(0, window.innerWidth - viewportPadding * 2)
    );
    const left = Math.min(
      Math.max(inputRect.left, viewportPadding),
      window.innerWidth - viewportPadding - width
    );

    this.cityResultList.style.left = `${left}px`;
    this.cityResultList.style.top = `${inputRect.bottom + 4}px`;
    this.cityResultList.style.width = `${width}px`;
  }

  private setRefreshButtonState(refreshing: boolean): void {
    if (!this.refreshButton) {
      return;
    }

    this.refreshButton.disabled = refreshing;
    this.refreshButton.innerHTML = refreshing
      ? `<svg class="b3-button__icon"><use xlink:href="#iconRefresh"></use></svg><span>${this.t(
          "actions.refreshing",
          "Refreshing..."
        )}</span>`
      : `<svg class="b3-button__icon"><use xlink:href="#iconRefresh"></use></svg><span>${this.t(
          "actions.refresh",
          "Refresh now"
        )}</span>`;
  }

  private hasValidConfig(): boolean {
    return Boolean(this.config.key && this.config.city);
  }

  private normalizeInterval(value: unknown): number {
    const interval = Number(value);
    return REFRESH_INTERVAL_OPTIONS.includes(interval)
      ? interval
      : DEFAULT_CONFIG.intervalMinutes;
  }
}
