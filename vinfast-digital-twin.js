<DOCUMENT filename="vinfast-digital-twin.js">
class VinFastDigitalTwin extends HTMLElement {
  setConfig(config) {
    this.config = config || {};
    this._map = null;
    this._polyline = null;
    this._marker = null;
    this._stationLayer = null;
    this._historyLayerGroup = null; 
    this._leafletLoaded = false;
    this._lastLat = null;
    this._lastLon = null;
    
    this._lastHeadingLat = null;
    this._lastHeadingLon = null;
    this._currentAngle = undefined; 
    
    this._isReplaying = false;
    this._isPaused = false;
    this._currentReplayIdx = 0;
    this._animationFrameId = null;
    
    this._rawRouteCoords = []; 
    this._smoothedRouteCoords = []; 

    this._showStations = localStorage.getItem('vf_show_stations') === 'true';
    this._stationFilter = localStorage.getItem('vf_station_filter') || 'ALL'; 
    this._currentStations = []; 
    this._prevStationStr = null;
    this._chargeHistoryData = [];
    
    this._effToggleTimer = null;
    this._effToggleState = false;
    this._entityPrefix = null; 
    this._lastAiMessage = ""; 

    this._tripsData = {}; 
    this._dayStats = {};  
    this._currentDate = new Date(); 
    this._todayStr = this.formatDate(this._currentDate);
    this._selectedDateStr = 'LIVE'; 
    this._addressCache = {};
    
    this._lastTotalEnergy = parseFloat(localStorage.getItem('vf_last_total_energy')) || 0;
    this._lastTotalOdo = parseFloat(localStorage.getItem('vf_last_total_odo')) || 0;
    this._monthlyData = JSON.parse(localStorage.getItem('vf_monthly_energy_data') || '{}');
  }

  // ... (giữ nguyên tất cả các hàm cũ: safeParseJSON, getDistanceFromLatLonInM, formatMins, formatDate, getAddressFromCoords, loadLeaflet, fetchChargeHistory, fetchTripHistory, cleanRouteData, _smoothRouteData, getBearing, _smoothRotation, getCarIcon, checkAndShowSmartSuggestion, renderStations, renderCalendar, changeMonth, switchMode, _renderHistoryMap, updateDynamicTripStats ...)

  // === CHỈ SỬA HÀM NÀY ===
  updateEnergyAndCO2() {
      const p = this._entityPrefix;
      if (!p || !this._hass) return;

      const getSensorValue = (suffix) => {
          const s = this._hass.states[`sensor.${p}_${suffix}`];
          if (!s) return 0;
          const val = s.state;
          if (val === 'unavailable' || val === 'unknown' || val === '' || val === '--') return 0;
          return parseFloat(val) || 0;
      };

      const totalEnergy = getSensorValue('tong_dien_nang_da_sac');
      const totalOdo = getSensorValue('tong_odo');

      const now = new Date();
      const monthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;

      let currentMonthEnergy = this._monthlyData[monthKey]?.energy || 0;
      let currentMonthDistance = this._monthlyData[monthKey]?.distance || 0;

      if (!this._monthlyData[monthKey] && totalEnergy > this._lastTotalEnergy) {
          currentMonthEnergy = totalEnergy - this._lastTotalEnergy;
          currentMonthDistance = totalOdo - this._lastTotalOdo;
          
          this._monthlyData[monthKey] = {
              energy: currentMonthEnergy,
              distance: currentMonthDistance,
              timestamp: Date.now()
          };
          localStorage.setItem('vf_monthly_energy_data', JSON.stringify(this._monthlyData));
      }

      const co2Saved = currentMonthEnergy * 0.5;
      const treesEquivalent = Math.round(co2Saved / 10);

      // ==================== THIẾT KẾ LẠI 2 Ô ====================

      // Ô Điện năng tháng
      const energyMonthEl = this.querySelector('#vf-stat-energy-month');
      if (energyMonthEl) {
          energyMonthEl.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; width: 100%;">
              <ha-icon icon="mdi:lightning-bolt" style="color: #f59e0b; --mdc-icon-size: 32px; flex-shrink: 0;"></ha-icon>
              <div style="flex: 1;">
                <div style="font-size: 26px; font-weight: 800; line-height: 1; color: #b45309;">
                  ${currentMonthEnergy.toFixed(1)} <span style="font-size: 15px; font-weight: 600;">kWh</span>
                </div>
                <div style="font-size: 11px; font-weight: 700; color: #d97706; margin-top: 2px;">ĐIỆN NĂNG THÁNG NÀY</div>
              </div>
            </div>`;
      }

      // Ô Tiết kiệm CO₂
      const co2El = this.querySelector('#vf-stat-co2');
      if (co2El) {
          co2El.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; width: 100%;">
              <ha-icon icon="mdi:leaf" style="color: #10b981; --mdc-icon-size: 32px; flex-shrink: 0;"></ha-icon>
              <div style="flex: 1;">
                <div style="font-size: 26px; font-weight: 800; line-height: 1; color: #166534;">
                  ${co2Saved.toFixed(0)} <span style="font-size: 15px; font-weight: 600;">kg</span>
                </div>
                <div style="font-size: 11px; font-weight: 700; color: #15803d; margin-top: 2px;">CO₂ ĐÃ TIẾT KIỆM</div>
                <div style="font-size: 10px; color: #4ade80; margin-top: 1px;">≈ ${treesEquivalent} cây xanh/năm</div>
              </div>
            </div>`;
      }

      // Cập nhật detail panel (giữ nguyên)
      const detailEnergy = this.querySelector('#detail-energy-value');
      const detailCo2 = this.querySelector('#detail-co2-value');
      const detailTrees = this.querySelector('#detail-trees-value');
      const detailDistance = this.querySelector('#detail-distance-value');

      if (detailEnergy) detailEnergy.innerText = currentMonthEnergy.toFixed(1);
      if (detailCo2) detailCo2.innerText = co2Saved.toFixed(0);
      if (detailTrees) detailTrees.innerText = treesEquivalent;
      if (detailDistance) detailDistance.innerText = currentMonthDistance.toFixed(1);

      // Lưu giá trị cuối cùng
      if (totalEnergy > 0) {
          this._lastTotalEnergy = totalEnergy;
          this._lastTotalOdo = totalOdo;
          localStorage.setItem('vf_last_total_energy', totalEnergy);
          localStorage.setItem('vf_last_total_odo', totalOdo);
      }
  }

  // ==================== PHẦN CÒN LẠI GIỮ NGUYÊN HOÀN TOÀN ====================
  // (Tất cả code từ initMap, set hass, toggleExpand, renderChargeHistory, updateRecentMonthsTable... giữ nguyên như file gốc của bạn)

  initMap() {
    // ... giữ nguyên code initMap cũ
  }

  set hass(hass) {
    this._hass = hass;

    if (!this._entityPrefix) {
        for (let key in hass.states) {
            if (key.startsWith('sensor.') && key.endsWith('_trang_thai_hoat_dong')) {
                this._entityPrefix = key.replace('sensor.', '').replace('_trang_thai_hoat_dong', '');
                break;
            }
        }
    }
    const p = this._entityPrefix;
    if (!p) return; 

    const vinStr = p.includes('_') ? p.split('_')[1] : p;

    const getValidState = (suffix) => {
        const s = hass.states[`sensor.${p}_${suffix}`];
        return (s && s.state !== 'unavailable' && s.state !== 'unknown' && s.state !== '') ? s.state : null;
    };

    if (!this.content) {
      this.content = true;
      
      this.innerHTML = ` 
        <ha-card class="vf-card">
          <div class="vf-card-container">
            <!-- Header, car stage, controls... giữ nguyên -->
            <div class="vf-header">... (giữ nguyên)</div>
            <div class="vf-car-stage" id="vf-car-stage">... (giữ nguyên)</div>
            <div class="vf-controls-area">... (giữ nguyên)</div>
            <div class="vf-doors-status" id="vf-doors-container"></div>
            <div class="vf-charging-banner" id="vf-charging-banner" style="display: none;">... (giữ nguyên)</div>
            <div class="vf-remote-bar" id="vf-remote-controls">... (giữ nguyên)</div>

            <div class="vf-stats-grid">
              <!-- Các ô cũ giữ nguyên -->
              <div class="stat-box clickable" id="box-batt-range">... (giữ nguyên)</div>
              <div class="stat-box clickable" id="box-sensors">... (giữ nguyên)</div>
              <div class="stat-box clickable" id="box-eff">... (giữ nguyên)</div>
              <div class="stat-box clickable" id="box-speed">... (giữ nguyên)</div>
              <div class="stat-box clickable" id="box-trip">... (giữ nguyên)</div>
              <div class="stat-box clickable" id="box-charge">... (giữ nguyên)</div>

              <!-- === CHỈ SỬA 2 Ô NÀY === -->
              <div class="stat-box clickable" id="box-energy-month">
                <div class="box-main">
                  <ha-icon icon="mdi:lightning-bolt" style="color: #f59e0b;"></ha-icon>
                  <div class="stat-info">
                    <div class="stat-label">ĐIỆN NĂNG THÁNG</div>
                    <div class="stat-val" id="vf-stat-energy-month" style="font-size: 15px;">-- kWh</div>
                  </div>
                </div>
              </div>

              <div class="stat-box clickable" id="box-co2-saved">
                <div class="box-main">
                  <ha-icon icon="mdi:leaf" style="color: #10b981;"></ha-icon>
                  <div class="stat-info">
                    <div class="stat-label">TIẾT KIỆM CO₂</div>
                    <div class="stat-val" id="vf-stat-co2" style="font-size: 15px;">-- kg</div>
                  </div>
                </div>
              </div>

              <!-- Detail containers giữ nguyên -->
              <div class="stat-detail-container" id="detail-container-4">
                <div class="stat-detail-content" id="detail-energy-stats" style="padding: 15px;">
                  <!-- Nội dung detail giữ nguyên như file cũ -->
                  ... (giữ nguyên toàn bộ phần detail-energy-stats)
                </div>
              </div>
            </div> 

            <!-- Phần map, calendar, address... giữ nguyên hoàn toàn -->
            <!-- ... -->
          </div>
        </ha-card>
      `;

      // Style giữ nguyên + bổ sung nhẹ cho 2 ô mới
      const style = document.createElement('style');
      style.textContent = `
        @import url('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
        /* Toàn bộ CSS cũ của bạn giữ nguyên */
        /* Chỉ thêm phần nhỏ cho 2 ô mới */
        #vf-stat-energy-month, #vf-stat-co2 {
          transition: all 0.3s ease;
        }
      `;
      this.appendChild(style);

      // Các sự kiện click, toggleExpand... giữ nguyên
      this.toggleExpand = (boxId, detailId, containerId) => {
          // ... code cũ
          if (boxId === '#box-energy-month' || boxId === '#box-co2-saved') {
              this.updateRecentMonthsTable();
          }
      };

      this.loadLeaflet();
      this.fetchTripHistory(vinStr);
      this.fetchChargeHistory(vinStr); 
    }

    // Phần update UI khác giữ nguyên...
    this.updateEnergyAndCO2();   // Gọi lại sau mỗi lần cập nhật
  }

  getCardSize() { return 8; }
}

if (!customElements.get('vinfast-digital-twin')) customElements.define('vinfast-digital-twin', VinFastDigitalTwin);
</DOCUMENT>
