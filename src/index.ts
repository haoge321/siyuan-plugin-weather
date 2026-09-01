import { Plugin, Setting, showMessage } from "siyuan";
import amapCities from "./data/amap-cities.json";

const STATUS_ITEM_ID = "weather-status";
const STORAGE_NAME = "weather-config";
const WEATHER_API_ENDPOINT =
  "https://restapi.amap.com/v3/weather/weatherInfo";
const REFRESH_INTERVAL_OPTIONS = [5, 10, 30, 60];
const CITY_RESULT_LIMIT = 20;
const SETTING_WIDTH = "960px";
const SETTING_CONTROL_WIDTH = "260px";
const DEFAULT_CONFIG: WeatherConfig = {
  key: "",
  city: "",
  intervalMinutes: 10
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
  private keyInput!: HTMLInputElement;
  private citySearchInput!: HTMLInputElement;
  private cityPicker!: HTMLElement;
  private cityResultList!: HTMLElement;
  private selectedCity?: AmapCity;
  private intervalSelect!: HTMLSelectElement;
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
    this.keyInput.className = "b3-text-field fn__block";
    this.keyInput.type = "password";
    this.keyInput.autocomplete = "off";
    this.keyInput.placeholder = this.t(
      "settings.apiKey.placeholder",
      "Enter Amap Web Service API Key"
    );
    this.keyInput.style.cssText =
      `width:${SETTING_CONTROL_WIDTH};max-width:100%;box-sizing:border-box;`;

    this.cityPicker = document.createElement("div");
    this.cityPicker.style.cssText =
      `position:relative;width:${SETTING_CONTROL_WIDTH};max-width:100%;min-width:0;`;

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
    this.intervalSelect.className = "b3-select fn__block";
    this.intervalSelect.style.cssText =
      `width:${SETTING_CONTROL_WIDTH};max-width:100%;box-sizing:border-box;`;
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

    this.refreshButton = document.createElement("button");
    this.refreshButton.className =
      "b3-button b3-button--outline fn__flex-center";
    this.refreshButton.type = "button";
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
        intervalMinutes: this.normalizeInterval(savedConfig.intervalMinutes)
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
      "padding: 0 8px"
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
      const weatherTip = [
        this.t("weather.weather", "Weather: {value}", { value: weather }),
        live.temperature
          ? this.t("weather.temperature", "Temperature: {value}°C", {
              value: live.temperature
            })
          : "",
        live.humidity
          ? this.t("weather.humidity", "Humidity: {value}%", {
              value: live.humidity
            })
          : "",
        live.winddirection
          ? this.t("weather.windDirection", "Wind direction: {value}", {
              value: live.winddirection
            })
          : "",
        live.windpower
          ? this.t("weather.windPower", "Wind power: {value}", {
              value: live.windpower
            })
          : ""
      ]
        .filter(Boolean)
        .join("\n");
      this.setStatus(weather, weatherTip);
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

  private setStatus(text: string, label: string): void {
    if (!this.statusItem || !document.body.contains(this.statusItem)) {
      return;
    }

    this.statusItem.textContent = text;
    this.statusItem.setAttribute("aria-label", label);
  }

  private clearWeather(): void {
    this.lastWeather = "";
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
      intervalMinutes: this.normalizeInterval(this.intervalSelect.value)
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
