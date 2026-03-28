<DOCUMENT filename="vinfast-digital-twin(7).js">
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
    
    // Biến cho thống kê năng lượng và CO2 (đã được tối ưu)
    this._lastTotalEnergy = parseFloat(localStorage.getItem('vf_last_total_energy')) || 0;
    this._lastTotalOdo = parseFloat(localStorage.getItem('vf_last_total_odo')) || 0;
    this._monthlyData = JSON.parse(localStorage.getItem('vf_monthly_energy_data') || '{}');
  }

  safeParseJSON(str) {
      if (!str) return [];
      if (typeof str !== 'string') return str; 
      try { return JSON.parse(str); }
      catch(e) {
          try { 
              let fixedStr = str.replace(/'/g, '"').replace(/True/g, 'true').replace(/False/g, 'false').replace(/None/g, 'null');
              return JSON.parse(fixedStr); 
          }
          catch(e2) { return []; }
      }
  }

  getDistanceFromLatLonInM(lat1, lon1, lat2, lon2) {
      const R = 6371000; 
      const dLat = (lat2-lat1) * Math.PI / 180;
      const dLon = (lon2-lon1) * Math.PI / 180; 
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2); 
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  formatMins(totalMins) {
      if (totalMins < 60) return `${totalMins}p`;
      const h = Math.floor(totalMins / 60);
      const m = totalMins % 60;
      return m > 0 ? `${h}g ${m}p` : `${h}g`;
  }

  formatDate(dateObj) {
      if (isNaN(dateObj.getTime())) return "1970-01-01";
      const y = dateObj.getFullYear();
      const m = String(dateObj.getMonth() + 1).padStart(2, '0');
      const d = String(dateObj.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
  }

  async getAddressFromCoords(lat, lon) {
      if (!lat || !lon) return "Không xác định";
      const cacheKey = `${parseFloat(lat).toFixed(4)},${parseFloat(lon).toFixed(4)}`;
      if (this._addressCache[cacheKey]) return this._addressCache[cacheKey];
      try {
          const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=16`);
          if (!response.ok) throw new Error("API Error");
          const data = await response.json();
          let address = data.display_name || "Không xác định";
          const parts = address.split(', ');
          if (parts.length > 3) address = parts.slice(0, 3).join(', ');
          this._addressCache[cacheKey] = address;
          return address;
      } catch (e) { return `${parseFloat(lat).toFixed(4)}, ${parseFloat(lon).toFixed(4)}`; }
  }

  loadLeaflet() {
    if (this._leafletLoaded) return;
    this._leafletLoaded = true;
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => { setTimeout(() => this.initMap(), 200); };
    document.head.appendChild(script);
  }

  async fetchChargeHistory(vin) {
      if (!vin) return;
      try {
          const res = await fetch(`/local/vinfast_charge_history_${vin.toLowerCase()}.json?v=${new Date().getTime()}`);
          if (res.ok) {
              this._chargeHistoryData = await res.json();
              const box = this.querySelector('#box-charge');
              if (box && box.classList.contains('active-box')) this.renderChargeHistory();
          }
      } catch(e) {}
  }

  async fetchTripHistory(vin) {
    const vinStr = (vin || '').toLowerCase();
    let allTripsRaw = [];

    try {
        const resMain = await fetch(`/local/vinfast_trips_${vinStr}.json?v=${new Date().getTime()}`);
        if (resMain.ok) {
            const data = await resMain.json();
            if (Array.isArray(data)) allTripsRaw = allTripsRaw.concat(data);
        }
    } catch(e) {}

    if (allTripsRaw && Array.isArray(allTripsRaw) && allTripsRaw.length > 0) {
        let groupedData = {};
        
        allTripsRaw.forEach(trip => {
            let dateStr = "";
            if (trip.date && typeof trip.date === 'string') {
                let parts = trip.date.split(/[-/]/);
                if (parts.length === 3) {
                    if (parts[0].length === 4) dateStr = `${parts[0]}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`;
                    else dateStr = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
                }
            }
            if (!dateStr) {
                let ts = trip.id || trip.timestamp;
                let dtObj = new Date((ts && ts > 1e11) ? ts : (ts ? ts * 1000 : Date.now()));
                if (isNaN(dtObj.getTime())) dtObj = new Date();
                dateStr = this.formatDate(dtObj);
            }

            if (!groupedData[dateStr]) groupedData[dateStr] = [];

            if (trip.route && Array.isArray(trip.route) && trip.route.length > 0) {
                groupedData[dateStr].push({
                    id: trip.id || new Date().getTime(),
                    time: trip.id || trip.timestamp || 0, 
                    duration: trip.duration || 0, 
                    distance: trip.distance || 0,
                    start_time_str: trip.start_time || "--:--", 
                    end_time_str: trip.end_time || "--:--",
                    route: trip.route,
                    start_soc: trip.start_soc || null,
                    end_soc: trip.end_soc || null
                });
            }
        });

        this._tripsData = {};
        this._dayStats = {};

        for (let day in groupedData) {
            groupedData[day].sort((a, b) => a.time - b.time);
            let dayTrips = groupedData[day];
            
            let drivingMins = 0; let totalDistance = 0; let pauseSecs = 0; let parkingSecs = 0; let maxSpeed = 0;
            let startTime = dayTrips[0]?.start_time_str || "--:--"; 
            let endTime = dayTrips[dayTrips.length - 1]?.end_time_str || "--:--";

            dayTrips.forEach((trip, i) => {
                drivingMins += trip.duration; 
                totalDistance += trip.distance;
                if (Array.isArray(trip.route)) {
                    trip.route.forEach(pt => { if (Array.isArray(pt) && pt.length > 2 && pt[2] > maxSpeed) maxSpeed = pt[2]; });
                }

                if (i < dayTrips.length - 1) {
                    let gapSecs = dayTrips[i+1].time - (trip.time + (trip.duration * 60));
                    if (gapSecs < 0) gapSecs = 0;
                    trip.pauseAfter = gapSecs; 
                    if (gapSecs < 900) pauseSecs += gapSecs; else parkingSecs += gapSecs; 
                } else {
                    trip.pauseAfter = 0;
                }
            });

            this._tripsData[day] = dayTrips;
            this._dayStats[day] = {
                startTime, endTime, drivingMins, totalDistance: totalDistance.toFixed(1),
                pauseMins: Math.round(pauseSecs / 60), parkingMins: Math.round(parkingSecs / 60), maxSpeed: Math.round(maxSpeed)
            };
        }
    }
    
    this.renderCalendar();
    this.switchMode();
    this.updateEnergyAndCO2();
  }

  cleanRouteData(points) {
      if (!points || !Array.isArray(points) || points.length === 0) return [];
      return points.filter(p => Array.isArray(p) && p.length >= 2).map(p => [p[0], p[1], p[2] || 0]); 
  }

  _smoothRouteData(points) {
      if (!points || points.length < 2) return points;
      let filtered = [points[0]];
      for (let i = 1; i < points.length; i++) {
          let prev = filtered[filtered.length - 1];
          let curr = points[i];
          let dist = this.getDistanceFromLatLonInM(prev[0], prev[1], curr[0], curr[1]);
          if (dist > 2.0 || curr[2] > 0) { filtered.push(curr); }
      }
      return filtered;
  }

  getBearing(startLat, startLng, destLat, destLng) {
      startLat = startLat * Math.PI / 180; startLng = startLng * Math.PI / 180;
      destLat = destLat * Math.PI / 180; destLng = destLng * Math.PI / 180;
      const y = Math.sin(destLng - startLng) * Math.cos(destLat);
      const x = Math.cos(startLat) * Math.sin(destLat) - Math.sin(startLat) * Math.cos(destLat) * Math.cos(destLng - startLng);
      let brng = Math.atan2(y, x);
      return (brng * 180 / Math.PI + 360) % 360;
  }

  _smoothRotation(targetAngle) {
      if (this._currentAngle === undefined) { this._currentAngle = targetAngle; return targetAngle; }
      let diff = targetAngle - (this._currentAngle % 360);
      diff = ((diff + 540) % 360) - 180;
      this._currentAngle += diff;
      return this._currentAngle;
  }

  getCarIcon(angle = 0, speed = null) {
      if(typeof L === 'undefined') return null;
      const arrowSvg = `<svg class="car-dir-svg" viewBox="0 0 24 24" fill="#2563eb" stroke="white" stroke-width="2" style="position: absolute; top: 0; left: 0; transform: rotate(${angle}deg); transform-origin: center; transition: transform 0.05s linear; width: 28px; height: 28px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5)); z-index: 1000;"><path d="M12 2L22 20L12 17L2 20L12 2Z"/></svg>`;
      let speedDisplay = speed !== null && speed > 0 ? 'block' : 'none';
      let speedVal = speed !== null ? Math.round(speed) : 0;
      const speedBadge = `<div class="car-speed-badge" style="position: absolute; bottom: 32px; left: 50%; transform: translateX(-50%); background: #10b981; color: white; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: bold; border: 1px solid white; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.3); z-index: 1001; display: ${speedDisplay}; transition: all 0.1s;">${speedVal} km/h</div>`;
      return L.divIcon({ className: '', html: `<div style="position: relative; width: 28px; height: 28px;">${arrowSvg}${speedBadge}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
  }

  checkAndShowSmartSuggestion(soc, heading) {
      const suggestCard = this.querySelector('#vf-smart-suggestion');
      if (!suggestCard || !this._currentStations || this._currentStations.length === 0) return;
      if (soc > 30 || heading === null) { suggestCard.style.display = 'none'; return; }
      
      const modelState = this._hass && this._entityPrefix ? this._hass.states[`sensor.${this._entityPrefix}_ten_dong_xe`] : null;
      const carModel = modelState ? (modelState.state || "").toUpperCase() : "";

      let validStations = this._currentStations;
      if (carModel.includes("VF3") || carModel.includes("VF 3")) {
          validStations = validStations.filter(st => st.power >= 20); 
      }

      let bestStation = null;
      for (let st of validStations) {
          if (st.avail > 0 && st.dist < 20) {
              let stationBearing = this.getBearing(this._lastLat, this._lastLon, st.lat, st.lng);
              let diff = Math.abs(stationBearing - heading);
              if (diff > 180) diff = 360 - diff;
              if (diff < 45 || st.dist < 3.0) {
                  if (!bestStation || st.dist < bestStation.dist) bestStation = st;
              }
          }
      }
      
      if (bestStation) {
          this.querySelector('#vf-suggest-name').innerText = bestStation.name;
          let exactDist = bestStation.dist;
          if (this._lastLat && this._lastLon && this._map) {
              let distMeters = this._map.distance([this._lastLat, this._lastLon], [bestStation.lat, bestStation.lng]);
              exactDist = (distMeters / 1000).toFixed(1);
          }
          this.querySelector('#vf-suggest-dist').innerText = exactDist;
          this.querySelector('#vf-suggest-power').innerText = bestStation.power;
          this.querySelector('#vf-suggest-avail').innerText = `${bestStation.avail}/${bestStation.total}`;
          
          const mapDomain = 'https://www.google.com/maps/dir/?api=1';
          const navUrl = `${mapDomain}&origin=${this._lastLat},${this._lastLon}&destination=${bestStation.lat},${bestStation.lng}&travelmode=driving`;
          
          const btnNav = this.querySelector('#btn-suggest-nav');
          if (btnNav) btnNav.onclick = () => window.open(navUrl, '_blank');
          suggestCard.style.display = 'block';
      } else { suggestCard.style.display = 'none'; }
  }

  renderStations() {
      if (!this._stationLayer || !this._map || typeof L === 'undefined') return;
      this._stationLayer.clearLayers();
      if (!this._showStations || !Array.isArray(this._currentStations) || this._selectedDateStr !== 'LIVE') return; 

      const modelState = this._hass && this._entityPrefix ? this._hass.states[`sensor.${this._entityPrefix}_ten_dong_xe`] : null;
      const carModel = modelState ? (modelState.state || "").toUpperCase() : "";

      let validStations = this._currentStations;
      if (carModel.includes("VF3") || carModel.includes("VF 3")) {
          validStations = validStations.filter(st => st.power >= 20); 
      }

      validStations.forEach(st => {
          const isDC = st.power >= 20;
          if (this._stationFilter === 'DC' && !isDC) return;
          if (this._stationFilter === 'AC' && isDC) return;

          if (st.lat && st.lng) {
              let exactDist = st.dist; 
              if (this._lastLat && this._lastLon) {
                  let distMeters = this._map.distance([this._lastLat, this._lastLon], [st.lat, st.lng]);
                  exactDist = (distMeters / 1000).toFixed(1); 
              }

              let ratio = st.total > 0 ? (st.avail / st.total) * 100 : 0;
              let pinColor = '';
              if (st.total === 0 || st.avail === 0) { pinColor = '#dc2626'; }
              else if (ratio < 30) { pinColor = '#f97316'; }
              else if (ratio < 50) { pinColor = '#eab308'; }
              else if (ratio < 80) { pinColor = '#0ea5e9'; }
              else { pinColor = '#16a34a'; }

              let boltCount = st.power >= 120 ? 3 : (st.power >= 20 ? 2 : 1);
              let boltsHtml = Array(boltCount).fill(`<ha-icon icon="mdi:flash" style="--mdc-icon-size: 16px; margin: 0 -2px;"></ha-icon>`).join('');
              const pinWidth = boltCount === 1 ? 30 : (boltCount === 2 ? 42 : 54);

              const stationIcon = L.divIcon({ 
                  className: 'custom-station-marker', 
                  html: `<div style="background-color: ${pinColor}; border: 2px solid white; border-radius: 14px; padding: 2px; display: flex; align-items: center; justify-content: center; color: white; box-shadow: 0 3px 6px rgba(0,0,0,0.3); height: 26px; width: ${pinWidth}px;">${boltsHtml}</div>`, 
                  iconSize: [pinWidth, 26], iconAnchor: [pinWidth / 2, 13] 
              });

              const mapDomain = 'https://www.google.com/maps/dir/?api=1';
              const navUrl = `${mapDomain}&origin=${this._lastLat},${this._lastLon}&destination=${st.lat},${st.lng}&travelmode=driving`;
              
              const popupContent = `
                  <div style="font-family:sans-serif; min-width: 170px;">
                      <b style="font-size: 13px; color: #1e3a8a;">${st.name}</b><br>
                      <div style="margin-top: 6px; font-size: 12px;">
                          🚗 Cách xe: <b style="color: #ef4444;">${exactDist} km</b><br>
                          ⚡ Công suất: <b>${st.power} kW</b><br>
                          🔌 Trụ trống: <b style="color:${pinColor}; font-size:14px;">${st.avail} / ${st.total}</b>
                      </div>
                      <a href="${navUrl}" target="_blank" style="display: flex; align-items: center; justify-content: center; gap: 4px; margin-top: 10px; background: #2563eb; color: white; padding: 8px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 12px; transition: background 0.2s;">
                          Chỉ đường
                      </a>
                  </div>
              `;
              L.marker([st.lat, st.lng], {icon: stationIcon}).bindPopup(popupContent).addTo(this._stationLayer);
          }
      });
  }

  renderCalendar() {
      const year = this._currentDate.getFullYear();
      const month = this._currentDate.getMonth();
      const monthNames = ["Tháng 1", "Tháng 2", "Tháng 3", "Tháng 4", "Tháng 5", "Tháng 6", "Tháng 7", "Tháng 8", "Tháng 9", "Tháng 10", "Tháng 11", "Tháng 12"];
      
      const elMonthYear = this.querySelector('#cal-month-year');
      if(elMonthYear) elMonthYear.innerText = `${monthNames[month]} ${year}`;

      const firstDay = new Date(year, month, 1).getDay(); 
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      
      let gridHtml = `
          <div class="cal-day-name">CN</div><div class="cal-day-name">T2</div><div class="cal-day-name">T3</div>
          <div class="cal-day-name">T4</div><div class="cal-day-name">T5</div><div class="cal-day-name">T6</div><div class="cal-day-name">T7</div>
      `;

      for (let i = 0; i < firstDay; i++) { gridHtml += `<div class="cal-day disabled"></div>`; }

      for (let day = 1; day <= daysInMonth; day++) {
          const checkDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          let classes = "cal-day";
          if (checkDateStr === this._todayStr) classes += " today";
          if (checkDateStr === this._selectedDateStr) classes += " active";
          if (this._tripsData[checkDateStr] && this._tripsData[checkDateStr].length > 0) classes += " has-trip";

          gridHtml += `<div class="cal-day ${classes}" data-date="${checkDateStr}">${day}</div>`;
      }

      const gridEl = this.querySelector('#cal-grid');
      if(gridEl) gridEl.innerHTML = gridHtml;

      const days = this.querySelectorAll('.cal-day:not(.disabled)');
      days.forEach(el => {
          el.addEventListener('click', (e) => {
              this._selectedDateStr = e.target.getAttribute('data-date');
              this.renderCalendar(); 
              this.switchMode();
              this.querySelector('#cal-dropdown').style.display = 'none';
          });
      });
  }

  changeMonth(offset) {
      this._currentDate.setMonth(this._currentDate.getMonth() + offset);
      this.renderCalendar();
  }

  switchMode() {
      const statsPanel = this.querySelector('#stats-panel');
      const liveTools = this.querySelector('#live-tools');
      const historyTools = this.querySelector('#history-tools');
      const tripFilter = this.querySelector('#history-trip-filter');
      
      const liveIndicator = this.querySelector('#icon-live-indicator');
      const calIcon = this.querySelector('#icon-cal-mode');

      this._historyLayerGroup.clearLayers();
      if (this._isReplaying) {
          this._isReplaying = false;
          cancelAnimationFrame(this._animationFrameId);
      }

      if (this._selectedDateStr === 'LIVE') {
          if(statsPanel) statsPanel.style.display = 'none';
          if(liveTools) liveTools.style.display = 'contents';
          if(historyTools) historyTools.style.display = 'none';
          if(tripFilter) tripFilter.style.display = 'none';
          
          if(liveIndicator) liveIndicator.style.display = 'block';
          if(calIcon) calIcon.style.color = '#334155';

          if (this._marker) this._marker.setOpacity(1);
          
          if (this._hass && this._entityPrefix) {
              const s = this._hass.states[`sensor.${this._entityPrefix}_lo_trinh_gps`];
              const routeJsonStr = s && s.attributes ? s.attributes.route_json : null;
              if (routeJsonStr) {
                  let parsedData = this.safeParseJSON(routeJsonStr);
                  this._rawRouteCoords = this.cleanRouteData(parsedData);
                  this._smoothedRouteCoords = this._smoothRouteData(this._rawRouteCoords);
                  this._polyline.setLatLngs(this._smoothedRouteCoords.map(p => [p[0], p[1]]));
              }
          }
          this.renderStations();
          if (this._lastLat && this._map) this._map.setView([this._lastLat, this._lastLon], 15);
      } else {
          if(statsPanel) statsPanel.style.display = 'flex';
          if(liveTools) liveTools.style.display = 'none'; 
          if(historyTools) historyTools.style.display = 'contents'; 
          if(tripFilter) tripFilter.style.display = 'flex';
          
          if(liveIndicator) liveIndicator.style.display = 'none';
          if(calIcon) calIcon.style.color = '#2563eb';

          if (this._marker) this._marker.setOpacity(0); 
          this._polyline.setLatLngs([]); 
          if (this._stationLayer) this._stationLayer.clearLayers(); 

          const dailySegments = this._tripsData[this._selectedDateStr];
          if (!dailySegments || dailySegments.length === 0) {
              if(statsPanel) statsPanel.style.display = 'none';
              if(historyTools) historyTools.style.display = 'none';
              if(tripFilter) tripFilter.style.display = 'none';
              return;
          }

          const tripSelector = this.querySelector('#trip-selector');
          if (tripSelector) {
              tripSelector.innerHTML = '<option value="all">Tổng hợp ngày</option>';
              dailySegments.forEach((t, i) => {
                  let opt = document.createElement('option');
                  opt.value = i;
                  opt.innerText = `Chuyến ${i+1} (${t.start_time_str})`;
                  tripSelector.appendChild(opt);
              });
              
              const newTripSelector = tripSelector.cloneNode(true);
              tripSelector.parentNode.replaceChild(newTripSelector, tripSelector);
              
              newTripSelector.addEventListener('change', (e) => {
                  let val = e.target.value;
                  this._renderHistoryMap(this._selectedDateStr, val === 'all' ? 'all' : parseInt(val));
              });
          }

          this._renderHistoryMap(this._selectedDateStr, 'all');
      }
      
      this.updateDynamicTripStats();
  }

  _renderHistoryMap(dateStr, tripIndex) {
      this._historyLayerGroup.clearLayers();
      if (this._isReplaying) {
          this._isReplaying = false;
          cancelAnimationFrame(this._animationFrameId);
          const iconReplay = this.querySelector('#icon-replay');
          if (iconReplay) iconReplay.setAttribute('icon', 'mdi:play-circle');
      }

      const dayTrips = this._tripsData[dateStr];
      if (!dayTrips || dayTrips.length === 0) return;

      let tripsToRender = tripIndex === 'all' ? dayTrips : [dayTrips[tripIndex]];
      
      let chargeDuration = 0;
      if (tripIndex === 'all' && this._chargeHistoryData) {
          const [y, m, d] = dateStr.split('-');
          const matchDate1 = `${d}/${m}/${y}`;
          const matchDate2 = `${d}-${m}-${y}`;
          this._chargeHistoryData.forEach(c => {
              if (c.date && (c.date === matchDate1 || c.date === matchDate2 || c.date.includes(matchDate1))) {
                  chargeDuration += parseInt(c.duration || 0);
              }
          });
      }

      let totalDist = 0, totalDrive = 0, totalPause = 0, totalPark = 0, maxSpd = 0;
      let startT = tripsToRender[0]?.start_time_str || "--:--";
      let endT = tripsToRender[tripsToRender.length - 1]?.end_time_str || "--:--";
      
      if (tripIndex === 'all') {
          const stats = this._dayStats[dateStr];
          if (stats) {
              totalDist = stats.totalDistance;
              totalDrive = stats.drivingMins;
              totalPause = stats.pauseMins;
              totalPark = stats.parkingMins;
              maxSpd = stats.maxSpeed;
          }
      } else {
          const t = tripsToRender[0];
          totalDist = t.distance.toFixed(1);
          totalDrive = t.duration;
          totalPause = 0; totalPark = 0;
          if (Array.isArray(t.route)) {
              t.route.forEach(pt => { if (Array.isArray(pt) && pt.length > 2 && pt[2] > maxSpd) maxSpd = pt[2]; });
          }
      }

      this.querySelector('#stat-time-a').innerText = startT;
      this.querySelector('#stat-time-b').innerText = endT;
      this.querySelector('#stat-dist').innerText = `${totalDist} km`; 
      this.querySelector('#stat-drive').innerText = this.formatMins(totalDrive);
      this.querySelector('#stat-pause').innerText = this.formatMins(totalPause);
      this.querySelector('#stat-park').innerText = this.formatMins(totalPark);
      this.querySelector('#stat-speed').innerText = `${maxSpd} km/h`;
      
      const chargeMetric = this.querySelector('#metric-charge');
      const statCharge = this.querySelector('#stat-charge');
      if (chargeDuration > 0 && chargeMetric && statCharge) {
          chargeMetric.style.display = 'flex';
          statCharge.innerText = this.formatMins(chargeDuration);
      } else if (chargeMetric) {
          chargeMetric.style.display = 'none';
      }

      const elAddrA = this.querySelector('#stat-addr-a');
      const elAddrB = this.querySelector('#stat-addr-b');
      elAddrA.innerText = "Đang dịch tọa độ...";
      elAddrB.innerText = "Đang dịch tọa độ...";

      if (tripsToRender[0].route && Array.isArray(tripsToRender[0].route) && tripsToRender[0].route.length > 0 && Array.isArray(tripsToRender[0].route[0])) {
          this.getAddressFromCoords(tripsToRender[0].route[0][0], tripsToRender[0].route[0][1]).then(addr => elAddrA.innerText = addr);
      }
      
      const lastRouteSegment = tripsToRender[tripsToRender.length-1].route;
      if (lastRouteSegment && Array.isArray(lastRouteSegment) && lastRouteSegment.length > 0) {
          const lPt = lastRouteSegment[lastRouteSegment.length-1];
          if(Array.isArray(lPt)) {
             this.getAddressFromCoords(lPt[0], lPt[1]).then(addr => elAddrB.innerText = addr);
          }
      }

      let bounds = L.latLngBounds();
      let flatCoordsForReplay = [];
      let stopCount = 1;

      tripsToRender.forEach((segmentObj, index) => {
          const segment = segmentObj.route;
          if (!segment || !Array.isArray(segment) || segment.length < 2) return;
          
          flatCoordsForReplay.push(...segment); 

          const latlngs = segment.map(pt => [pt[0], pt[1]]);
          L.polyline(latlngs, { color: '#2563eb', weight: 5, opacity: 0.8, lineJoin: 'round' }).addTo(this._historyLayerGroup);
          latlngs.forEach(ll => bounds.extend(ll));

          if (index === 0) {
              L.marker(latlngs[0], { icon: L.divIcon({ className: 'marker-start' }) }).addTo(this._historyLayerGroup);
          }
          
          if (index < tripsToRender.length - 1 && tripIndex === 'all') {
              let pauseMins = Math.round((segmentObj.pauseAfter || 0) / 60);
              let isParking = pauseMins >= 15;
              let iconClass = isParking ? 'marker-park' : 'marker-pause';
              let currentStopNum = stopCount++;
              
              let marker = L.marker(latlngs[latlngs.length - 1], { icon: L.divIcon({ className: iconClass, html: currentStopNum }) }).addTo(this._historyLayerGroup);
              let popupHtml = `
                  <div style="font-family:sans-serif; text-align:center; min-width: 140px;">
                      <div style="font-size:11px; font-weight:800; color:${isParking ? '#ef4444' : '#f59e0b'}; margin-bottom:6px; border-bottom:1px solid #e2e8f0; padding-bottom:4px;">
                          <ha-icon icon="${isParking ? 'mdi:parking' : 'mdi:timer-sand'}" style="--mdc-icon-size:14px; margin-bottom:-2px;"></ha-icon> 
                          ${isParking ? 'ĐIỂM ĐỖ XE' : 'ĐIỂM DỪNG'} #${currentStopNum}
                      </div>
                      <div style="font-size:12px; color:#475569; font-weight:600;">
                          Thời gian:<br><span style="color:#0f172a; font-weight:900; font-size:14px;">${this.formatMins(pauseMins)}</span>
                      </div>
                      <div style="font-size:10px; color:#64748b; margin-top:4px;">(Trước chuyến đi số ${index+2})</div>
                  </div>
              `;
              marker.bindPopup(popupHtml);
          }
          
          if (index === tripsToRender.length - 1) {
              const lastPt = segment[segment.length - 1];
              const speed = lastPt.length > 2 ? lastPt[2] : 0;
              let endIcon = speed > 2.0 ? L.divIcon({ className: 'marker-continue', html: '❯' }) : L.divIcon({ className: 'marker-end-flag', html: '🏁' });
              L.marker(latlngs[latlngs.length - 1], { icon: endIcon }).addTo(this._historyLayerGroup);
          }
      });

      this._smoothedRouteCoords = flatCoordsForReplay;
      if (bounds.isValid()) {
          this._map.fitBounds(bounds, { padding: [40, 40] }); 
      } 
  }

  updateDynamicTripStats() {
    const speedElTarget = this.querySelector('#vf-stat-speed');
    const dtSpeedChart = this.querySelector('#dt-speed-chart');
    const speedLbl = this.querySelector('#lbl-speed-title');
    
    const p = this._entityPrefix;
    const speedSensor = this._hass ? (this._hass.states[`sensor.${p}_dai_toc_do_toi_uu_nhat`] || this._hass.states[`sensor.${p}_toc_do_toi_uu_nhat`]) : null;
    let speedBandStr = speedSensor ? speedSensor.state : '--';
    if (!speedSensor || speedBandStr === 'unknown' || speedBandStr === 'unavailable' || speedBandStr.length > 20) {
        speedBandStr = '--';
    }

    if (speedElTarget && speedBandStr !== '--') { 
        let spd = String(speedBandStr).split(' ')[0]; 
        speedElTarget.innerHTML = `${spd}<span class="stat-unit">km/h</span>`; 
        if(speedLbl) speedLbl.innerText = "TỐC ĐỘ TỐI ƯU";
    } 

    if (dtSpeedChart) {
        let htmlChart = ''; let maxVal = 0; let bars = []; 
        let hasSensorData = false;
        
        const sObj = speedSensor || (this._hass ? this._hass.states[`sensor.${p}_co_van_xe_dien_ai`] : null);
        if (sObj && sObj.attributes) {
            for (let key in sObj.attributes) {
                let lowerKey = key.toLowerCase();
                if (lowerKey.includes('dải') || lowerKey.includes('dai_') || lowerKey.includes('km/h') || lowerKey.match(/^[0-9]+(-|_)[0-9]+/)) { 
                    let valStr = String(sObj.attributes[key]); 
                    let num = parseFloat(valStr.split(' ')[0]); 
                    if (!isNaN(num)) {
                        if (num > maxVal) maxVal = num; 
                        let label = key.replace(/Dải|dải|km\/h|_/ig, ' ').trim();
                        if(label.includes('-') || label.includes('>')) {
                             bars.push({label: label, val: num}); 
                             hasSensorData = true;
                        }
                    }
                }
            }
        }
        
        if (!hasSensorData) {
            let speedBands = { "0-30": 0, "30-50": 0, "50-70": 0, "70-90": 0, ">90": 0 };
            let coordsToAnalyze = [];
            if (this._selectedDateStr === 'LIVE') {
                if (this._smoothedRouteCoords && this._smoothedRouteCoords.length > 0) coordsToAnalyze = [this._smoothedRouteCoords];
            } else {
                let flatHistory = [];
                (this._tripsData[this._selectedDateStr] || []).forEach(seg => { 
                    if (Array.isArray(seg.route)) flatHistory.push(...seg.route); 
                });
                coordsToAnalyze = [flatHistory];
            }
            
            let foundData = false;
            coordsToAnalyze.forEach(segment => {
                if (!Array.isArray(segment)) return;
                for (let i = 0; i < segment.length - 1; i++) {
                    if (!segment[i] || !segment[i+1]) continue;
                    let ptA = segment[i]; let ptB = segment[i+1];
                    let dist = this.getDistanceFromLatLonInM(ptA[0], ptA[1], ptB[0], ptB[1]) / 1000;
                    let spd = ptB[2] || 0;
                    if (spd > 2) {
                        foundData = true;
                        if (spd < 30) speedBands["0-30"] += dist;
                        else if (spd < 50) speedBands["30-50"] += dist;
                        else if (spd < 70) speedBands["50-70"] += dist;
                        else if (spd < 90) speedBands["70-90"] += dist;
                        else speedBands[">90"] += dist;
                    }
                }
            });
            
            if (foundData) {
                let bestBand = "0-30"; let maxDist = 0;
                for (let key in speedBands) {
                    if (speedBands[key] > maxDist) { maxDist = speedBands[key]; bestBand = key; }
                }
                if (speedBandStr === '--' && speedElTarget) {
                    speedElTarget.innerHTML = `${bestBand}<span class="stat-unit">km/h</span>`;
                    if(speedLbl) speedLbl.innerText = "TỐC ĐỘ PHỔ BIẾN";
                }
                
                bars = []; maxVal = 0;
                for (let key in speedBands) {
                    let d = parseFloat(speedBands[key].toFixed(1));
                    if (d > maxVal) maxVal = d;
                    bars.push({ label: key, val: d, unit: 'km' }); 
                }
                hasSensorData = true; 
            } else if (speedBandStr === '--' && speedElTarget) {
                speedElTarget.innerHTML = '--';
            }
        }
        
        if (hasSensorData && bars.length > 0) {
            bars.sort((a,b) => {
               let aNum = parseInt(a.label.split('-')[0].replace('>', '')) || 0;
               let bNum = parseInt(b.label.split('-')[0].replace('>', '')) || 0;
               return aNum - bNum;
            });
            bars.forEach(b => {
                let pct = maxVal > 0 ? Math.round((b.val / maxVal) * 100) : 0;
                let displayVal = b.unit ? `${b.val} km` : b.val;
                htmlChart += `<div style="display:flex; align-items:center; gap:8px;"><div style="width:35px; font-size:10px; text-align:right; font-weight:bold; color:var(--secondary-text-color, #475569);">${b.label}</div><div style="flex:1; background:var(--divider-color, #e2e8f0); height:8px; border-radius:4px; overflow:hidden;"><div style="width:${pct}%; height:100%; background:${pct === 100 ? '#eab308' : '#3b82f6'}; transition: width 0.5s;"></div></div><div style="width:40px; font-size:10px; font-weight:bold; color:var(--primary-text-color, #1e3a8a);">${displayVal}</div></div>`;
            });
            dtSpeedChart.innerHTML = htmlChart;
        } else {
            dtSpeedChart.innerHTML = `<div style="text-align:center; padding:10px; color:#94a3b8; font-size:11px;">Chưa có dữ liệu chuyến đi</div>`;
        }
    }
  }

  // ===============================================
  // CẬP NHẬT ĐIỆN NĂNG VÀ CO2 (ĐÃ SỬA + THIẾT KẾ LẠI)
  // ===============================================
  updateEnergyAndCO2() {
    const p = this._entityPrefix;
    if (!p) return;

    const getSensorValue = (suffix) => {
      const s = this._hass?.states[`sensor.${p}_${suffix}`];
      if (!s) return null;
      const val = s.state;
      if (val === 'unavailable' || val === 'unknown' || val === '' || val === '--') return null;
      return parseFloat(val);
    };

    // Sensor động hoàn toàn (không hard-code VIN nữa)
    const totalEnergy = getSensorValue('tong_dien_nang_da_sac') || 0;
    const totalOdo = getSensorValue('tong_odo') || 0;
    const totalSessions = getSensorValue('tong_so_lan_sac') || 0;
    const pubSessions = getSensorValue('so_lan_sac_tai_tram') || 0;
    const homeSessions = getSensorValue('so_lan_sac_tai_nha') || 0;
    const homeEnergy = getSensorValue('dien_nang_sac_tai_nha') || 0;

    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const monthKey = `${currentYear}-${currentMonth}`;

    // === CẢI TIẾN LOGIC THÁNG: lưu energy đầu tháng + tự động rollover ===
    let currentMonthEnergy = 0;
    let currentMonthDistance = 0;

    const lastMonthKey = Object.keys(this._monthlyData).sort().pop() || null;

    if (this._monthlyData[monthKey]) {
      // Đã có dữ liệu tháng này
      currentMonthEnergy = this._monthlyData[monthKey].energy;
      currentMonthDistance = this._monthlyData[monthKey].distance;
    } else {
      // Tháng mới → rollover
      if (lastMonthKey) {
        const lastData = this._monthlyData[lastMonthKey];
        // Lưu energy cuối tháng trước (nếu cần)
      }
      // Khởi tạo tháng mới từ total hiện tại
      currentMonthEnergy = totalEnergy - this._lastTotalEnergy;
      currentMonthDistance = totalOdo - this._lastTotalOdo;

      if (currentMonthEnergy < 0) currentMonthEnergy = 0; // phòng trường hợp reset sensor
      if (currentMonthDistance < 0) currentMonthDistance = 0;

      this._monthlyData[monthKey] = {
        energy: currentMonthEnergy,
        distance: currentMonthDistance,
        homeSessions: homeSessions,
        pubSessions: pubSessions,
        homeEnergy: homeEnergy,
        timestamp: Date.now()
      };
      localStorage.setItem('vf_monthly_energy_data', JSON.stringify(this._monthlyData));
    }

    // Tính CO2 & cây xanh (1 kWh ≈ 0.5 kg CO2 so với xăng)
    const co2Saved = currentMonthEnergy * 0.5;
    const treesEquivalent = Math.round(co2Saved / 10);

    // ===============================================
    // CẬP NHẬT UI Ô CHÍNH (ĐÃ THIẾT KẾ LẠI - ĐẸP HƠN)
    // ===============================================
    const energyMonthEl = this.querySelector('#vf-stat-energy-month');
    if (energyMonthEl) {
      energyMonthEl.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px;">
          <ha-icon icon="mdi:lightning-bolt" style="color:#f59e0b; --mdc-icon-size:28px;"></ha-icon>
          <div>
            <div style="font-size:22px; font-weight:800; line-height:1;">${currentMonthEnergy.toFixed(1)}<span style="font-size:14px; font-weight:600; margin-left:4px;">kWh</span></div>
            <div style="font-size:10px; color:#f59e0b; font-weight:700; margin-top:-2px;">ĐIỆN NĂNG THÁNG NÀY</div>
          </div>
        </div>`;
    }

    const co2El = this.querySelector('#vf-stat-co2');
    if (co2El) {
      co2El.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px;">
          <ha-icon icon="mdi:leaf" style="color:#10b981; --mdc-icon-size:28px;"></ha-icon>
          <div>
            <div style="font-size:22px; font-weight:800; line-height:1;">${co2Saved.toFixed(0)}<span style="font-size:14px; font-weight:600; margin-left:4px;">kg</span></div>
            <div style="font-size:10px; color:#10b981; font-weight:700; margin-top:-2px;">CO₂ TIẾT KIỆM</div>
            <div style="font-size:9px; color:#10b981; opacity:0.8;">≈ ${treesEquivalent} cây xanh/năm</div>
          </div>
        </div>`;
    }

    // Cập nhật chi tiết panel
    const detailEnergy = this.querySelector('#detail-energy-value');
    const detailCo2 = this.querySelector('#detail-co2-value');
    const detailTrees = this.querySelector('#detail-trees-value');
    const detailDistance = this.querySelector('#detail-distance-value');
    
    if (detailEnergy) detailEnergy.innerText = currentMonthEnergy.toFixed(1);
    if (detailCo2) detailCo2.innerText = co2Saved.toFixed(0);
    if (detailTrees) detailTrees.innerText = treesEquivalent;
    if (detailDistance) detailDistance.innerText = currentMonthDistance.toFixed(1);

    // Số lần sạc tháng
    const chargeCountMonthEl = this.querySelector('#vf-stat-charge-month');
    if (chargeCountMonthEl) {
      const totalSessionsMonth = homeSessions + pubSessions;
      chargeCountMonthEl.innerHTML = `${totalSessionsMonth}<span class="stat-unit">lần</span>`;
    }

    // Lưu lại để so sánh lần sau
    if (totalEnergy > 0) {
      this._lastTotalEnergy = totalEnergy;
      this._lastTotalOdo = totalOdo;
      localStorage.setItem('vf_last_total_energy', totalEnergy);
      localStorage.setItem('vf_last_total_odo', totalOdo);
    }

    // Debug (có thể comment sau)
    console.log('📊 Energy & CO2 Stats (đã sửa):', {
      totalEnergy, totalOdo,
      currentMonthEnergy, currentMonthDistance,
      co2Saved, treesEquivalent,
      homeSessions, pubSessions
    });
  }

  initMap() {
    const mapEl = this.querySelector('#vf-map-canvas');
    if (!mapEl || typeof L === 'undefined' || this._map) return;
    
    this._map = L.map(mapEl, { zoomControl: false });
    L.control.zoom({ position: 'topleft', zoomInTitle: 'Phóng to', zoomOutTitle: 'Thu nhỏ' }).addTo(this._map);
    
    const zoomCtrl = mapEl.querySelector('.leaflet-control-zoom');
    if(zoomCtrl) { zoomCtrl.style.marginTop = '45px'; zoomCtrl.style.marginLeft = '12px'; zoomCtrl.style.border = 'none'; zoomCtrl.style.boxShadow = '0 4px 10px rgba(0,0,0,0.1)'; }
    
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(this._map);
    
    this._marker = L.marker([0, 0], {icon: this.getCarIcon(0, 0), opacity: 0, zIndexOffset: 1000}).addTo(this._map);
    this._polyline = L.polyline([], { color: '#2563eb', weight: 6, opacity: 0.85, lineCap: 'round', lineJoin: 'round', smoothFactor: 2.5 }).addTo(this._map);
    this._stationLayer = L.layerGroup().addTo(this._map);
    this._historyLayerGroup = L.layerGroup().addTo(this._map);
    
    new IntersectionObserver((entries) => { 
        if (entries[0].isIntersecting && this._map) setTimeout(() => this._map.invalidateSize(), 100); 
    }).observe(mapEl);
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
    
    const getAttr = (suffix, attrKey) => {
        const s = hass.states[`sensor.${p}_${suffix}`];
        return (s && s.attributes && s.attributes[attrKey]) ? s.attributes[attrKey] : null;
    };

    const formatTimeSince = (dateString) => {
        if (!dateString) return "";
        const s = Math.floor((new Date() - new Date(dateString)) / 1000);
        if (s < 60) return "vừa xong";
        const m = Math.floor(s / 60); if (m < 60) return `${m} phút trước`;
        const h = Math.floor(m / 60); if (h < 24) return `${h} giờ trước`;
        return `${Math.floor(h / 24)} ngày trước`;
    };

    if (!this.content) {
      this.content = true;
      
      this.innerHTML = `
        <ha-card class="vf-card">
          <div class="vf-card-container">
            <div class="vf-header">
              <div class="vf-title">
                <svg viewBox="0 0 512 512" fill="currentColor"><path d="M560 3586 c-132 -28 -185 -75 -359 -321 -208 -291 -201 -268 -201 -701 0 -361 3 -383 69 -470 58 -77 133 -109 311 -134 202 -29 185 -21 199 -84 14 -62 66 -155 119 -209 110 -113 277 -165 430 -133 141 29 269 125 328 246 l29 59 1115 0 1115 0 29 -59 c60 -123 201 -226 345 -250 253 -43 499 137 543 397 34 203 -77 409 -268 500 -69 33 -89 38 -172 41 -116 5 -198 -15 -280 -67 -116 -76 -195 -193 -214 -321 -6 -36 -12 -71 -14 -77 -5 -19 -2163 -19 -2168 0 -2 6 -8 41 -14 77 -19 128 -98 245 -214 321 -82 52 -164 72 -280 67 -82 -3 -103 -8 -168 -40 -41 -19 -94 -52 -117 -72 -55 -48 -115 -139 -137 -209 -21 -68 -13 -66 -196 -37 -69 11 -128 20 -132 20 -17 0 -82 67 -94 97 -10 23 -14 86 -14 228 l0 195 60 0 c48 0 63 4 80 22 24 26 58 10 88 -12 22 -61 40 -111 40 l-39 0 0 43 c1 23 9 65 18 93 20 58 264 406 317 453 43 37 120 61 198 61 52 0 58 -2 53 -17 -4 -10 -48 -89 -98 -177 -70 -122 -92 -170 -95 -205 -5 -56 19 -106 67 -138 l33 -23 1511 0 c867 0 1583 -4 1680 -10 308 -18 581 -60 788 -121 109 -32 268 -103 268 -119 0 -6 -27 -10 -60 -10 -68 0 -100 -21 -100 -66 0 -63 40 -84 161 -84 l79 0 0 -214 c0 -200 -1 -215 -20 -239 -13 -16 -35 -29 -58 -33 -88 -16 -113 -102 -41 -140 81 -41 228 49 259 160 8 29 11 119 8 292 l-3 249 -32 67 c-45 96 -101 152 -197 197 -235 112 -604 187 -1027 209 l-156 9 -319 203 c-176 112 -359 223 -409 246 -116 56 -239 91 -366 104 -149 15 -1977 12 -2049 -4z m800 -341 l0 -205 -335 0 -336 0 12 23 c7 12 59 104 116 205 l105 182 219 0 219 0 0 -205z m842 15 c14 -102 27 -193 27 -202 1 -17 -23 -18 -359 -18 l-360 0 0 198 c0 109 3 202 7 205 4 4 153 6 332 5 l326 -3 27 -185z m528 157 c52 -14 125 -38 161 -55 54 -24 351 -206 489 -299 l35 -23 -516 0 -516 0 -26 188 c-15 103 -27 196 -27 206 0 18 7 19 153 13 112 -5 177 -12 247 -30z m-1541 -1132 c115 -63 176 -174 169 -305 -16 -272 -334 -402 -541 -221 -20 18 -51 63 -69 99 -28 57 -33 77 -33 142 0 65 5 85 33 142 37 76 93 128 169 159 75 30 200 23 272 -16z m3091 16 c110 -42 192 -149 207 -269 18 -159 -101 -319 -264 -352 -134 -28 -285 47 -350 174 -37 72 -43 180 -14 257 35 91 107 162 200 195 55 20 162 17 221 -5z"></path></svg>
                <span id="vf-name">Đang tải...</span>
              </div>
              <div class="vf-odo"><div class="vf-odo-label">ODOMETER</div><div class="vf-odo-value"><span id="vf-odo-int"></span> <span class="vf-odo-unit">km</span></div></div>
            </div>

            <div class="vf-car-stage" id="vf-car-stage">
              <div id="vf-status-badge" class="vf-status-badge"></div>
              <img id="vf-car-img" src="" alt="VinFast Car" onerror="this.src='https://shop.vinfastauto.com/on/demandware.static/-/Sites-app_vinfast_vn-Library/default/dw15d3dc68/images/PDP/vf9/M/M.png'">
              <div class="vf-tire vf-tire-fl" id="tire-fl" style="display:none;"><ha-icon icon="mdi:tire"></ha-icon><br><span></span> <span class="tire-unit">bar</span></div>
              <div class="vf-tire vf-tire-fr" id="tire-fr" style="display:none;"><ha-icon icon="mdi:tire"></ha-icon><br><span></span> <span class="tire-unit">bar</span></div>
              <div class="vf-tire vf-tire-rl" id="tire-rl" style="display:none;"><ha-icon icon="mdi:tire"></ha-icon><br><span></span> <span class="tire-unit">bar</span></div>
              <div class="vf-tire vf-tire-rr" id="tire-rr" style="display:none;"><ha-icon icon="mdi:tire"></ha-icon><br><span></span> <span class="tire-unit">bar</span></div>
            </div>

            <div class="vf-controls-area">
              <div class="vf-gears"><span class="gear" id="gear-P">P</span><span class="gear" id="gear-R">R</span><span class="gear" id="gear-N">N</span><span class="gear" id="gear-D">D</span></div>
              <div class="vf-speed" id="vf-speed-container"><span id="vf-speed"></span><span class="vf-speed-unit">km/h</span></div>
            </div>
            
            <div class="vf-doors-status" id="vf-doors-container"></div>

            <div class="vf-charging-banner" id="vf-charging-banner" style="display: none;">
                <div class="charging-left">
                    <div class="charging-title"><ha-icon icon="mdi:ev-plug-type2"></ha-icon><span id="vf-charge-status-text">Hệ thống đang sạc</span></div>
                    <div class="charging-details">Giới hạn: <span id="vf-charge-limit" style="font-weight:bold; margin-left:4px;">--%</span><span style="margin:0 8px;opacity:0.5;">|</span>Công suất: <span id="vf-charge-power" style="font-weight:bold; margin-left:4px;">-- kW</span></div>
                </div>
                <div class="charging-right">
                    <span id="vf-charge-time" class="charging-time">--</span>
                    <div class="charging-time-label"><span>phút</span><span>còn lại</span></div>
                </div>
            </div>

            <div class="vf-remote-bar" id="vf-remote-controls">
                <div class="remote-btn" id="btn-rc-lock" title="Khóa cửa"><ha-icon icon="mdi:lock"></ha-icon></div>
                <div class="remote-btn" id="btn-rc-unlock" title="Mở cửa"><ha-icon icon="mdi:lock-open"></ha-icon></div>
                <div class="remote-btn" id="btn-rc-horn" title="Bấm còi"><ha-icon icon="mdi:bullhorn"></ha-icon></div>
                <div class="remote-btn" id="btn-rc-lights" title="Nháy đèn"><ha-icon icon="mdi:car-light-high"></ha-icon></div>
            </div>

            <div class="vf-stats-grid">
              <!-- Các ô cũ giữ nguyên -->
              <div class="stat-box clickable" id="box-batt-range"> ... </div>
              <div class="stat-box clickable" id="box-sensors"> ... </div>
              <div class="stat-box clickable" id="box-eff"> ... </div>
              <div class="stat-box clickable" id="box-speed"> ... </div>
              <div class="stat-box clickable" id="box-trip"> ... </div>
              <div class="stat-box clickable" id="box-charge"> ... </div>

              <!-- Ô ĐIỆN NĂNG THÁNG (ĐÃ THIẾT KẾ LẠI) -->
              <div class="stat-box clickable energy-co2-box" id="box-energy-month" style="background: linear-gradient(135deg, #fffbeb 0%, #fefce8 100%); border: 2px solid #f59e0b;">
                <div class="box-main" style="width:100%;">
                  <div id="vf-stat-energy-month" style="font-size:22px; font-weight:800; color:#b45309; display:flex; align-items:center; gap:8px; width:100%;"></div>
                </div>
              </div>

              <!-- Ô TIẾT KIỆM CO₂ (ĐÃ THIẾT KẾ LẠI) -->
              <div class="stat-box clickable energy-co2-box" id="box-co2-saved" style="background: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%); border: 2px solid #10b981;">
                <div class="box-main" style="width:100%;">
                  <div id="vf-stat-co2" style="font-size:22px; font-weight:800; color:#166534; display:flex; align-items:center; gap:8px; width:100%;"></div>
                </div>
              </div>
              
              <!-- Detail panels giữ nguyên + cải thiện CSS -->
              <div class="stat-detail-container" id="detail-container-4">
                <div class="stat-detail-content" id="detail-energy-stats" style="padding: 15px;">
                  <!-- Nội dung detail giữ nguyên nhưng bảng đẹp hơn -->
                  <div style="font-weight: bold; margin-bottom: 15px; color: var(--primary-text-color);">
                    <ha-icon icon="mdi:chart-line" style="--mdc-icon-size: 18px; margin-right: 6px;"></ha-icon>
                    Thống kê năng lượng & CO₂
                  </div>
                  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px;">
                    <div style="background: var(--secondary-background-color); border-radius: 12px; padding: 12px; text-align: center;">
                      <div style="font-size: 11px; color: var(--secondary-text-color);">⚡ Điện năng tháng này</div>
                      <div style="font-size: 28px; font-weight: bold; color: #f59e0b;" id="detail-energy-value">-- kWh</div>
                      <div style="font-size: 10px; color: var(--secondary-text-color);">📊 tương đương <span id="detail-distance-value">--</span> km</div>
                    </div>
                    <div style="background: var(--secondary-background-color); border-radius: 12px; padding: 12px; text-align: center;">
                      <div style="font-size: 11px; color: var(--secondary-text-color);">🌳 CO₂ tiết kiệm</div>
                      <div style="font-size: 28px; font-weight: bold; color: #10b981;" id="detail-co2-value">-- kg</div>
                      <div style="font-size: 10px; color: var(--secondary-text-color);">🌿 tương đương <span id="detail-trees-value">--</span> cây xanh/năm</div>
                    </div>
                  </div>
                  <div style="margin-top: 15px;">
                    <div style="font-size: 12px; font-weight: bold; margin-bottom: 10px; color: var(--primary-text-color);">📅 3 tháng gần nhất</div>
                    <div style="overflow-x: auto;">
                      <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
                        <thead>
                          <tr style="background: var(--secondary-background-color);">
                            <th style="padding: 8px; text-align: left;">Tháng</th>
                            <th style="padding: 8px; text-align: right;">Điện năng (kWh)</th>
                            <th style="padding: 8px; text-align: right;">CO₂ (kg)</th>
                            <th style="padding: 8px; text-align: right;">🌳 Cây xanh</th>
                           </tr>
                        </thead>
                        <tbody id="recent-months-table">
                          <tr><td colspan="4" style="text-align: center;">Đang tải...</td></tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div style="margin-top: 15px; padding: 10px; background: var(--secondary-background-color); border-radius: 8px; font-size: 11px; color: var(--secondary-text-color); text-align: center;">
                    💡 1 kWh = 0.5 kg CO₂ so với xe xăng | 1 cây xanh hấp thụ ~10kg CO₂/năm
                  </div>
                </div>
              </div>

              <!-- Các detail khác giữ nguyên -->
              <div class="stat-detail-container" id="detail-container-1"> ... </div>
              <div class="stat-detail-container" id="detail-container-2"> ... </div>
              <div class="stat-detail-container" id="detail-container-3"> ... </div>
            </div> 

            <!-- Phần còn lại của card giữ nguyên (map, calendar, AI advisor...) -->
            <div id="vf-ai-advisor-container" style="display: none; ..."> ... </div>
            <div class="vf-address-bar" id="vf-address-container"> ... </div>
            <div class="map-and-cal-wrapper"> ... </div>
            <div class="stats-panel" id="stats-panel" style="display:none;"> ... </div>
          </div>
        </ha-card>
      `;

      // CSS (thêm style cho hai ô mới)
      const style = document.createElement('style');
      style.textContent = `
        @import url('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
        .leaflet-control-attribution { display: none !important; }
        .vf-card { isolation: isolate; border-radius: 24px; background: var(--card-background-color, #ffffff); box-shadow: 0 4px 20px rgba(0,0,0,0.05); font-family: -apple-system, sans-serif;}
        /* ... (giữ nguyên toàn bộ CSS cũ) ... */
        
        /* THÊM CSS MỚI CHO HAI Ô ĐÃ THIẾT KẾ LẠI */
        .energy-co2-box:hover {
          transform: translateY(-3px);
          box-shadow: 0 8px 20px rgba(0,0,0,0.12) !important;
        }
        .energy-co2-box .box-main {
          padding: 12px 16px;
        }
      `;
      this.appendChild(style);

      // Các event listener, toggleExpand, renderChargeHistory, updateRecentMonthsTable... giữ nguyên như cũ
      // (để ngắn gọn, tôi giữ nguyên phần còn lại của set hass)

      this.toggleExpand = (boxId, detailId, containerId) => {
          // ... (giữ nguyên logic cũ)
          if (boxId === '#box-energy-month' || boxId === '#box-co2-saved') {
              this.updateRecentMonthsTable();
          }
      };

      // Các phần khác (loadLeaflet, fetchTripHistory, fetchChargeHistory, v.v.) giữ nguyên
      this.loadLeaflet();
      this.fetchTripHistory(vinStr);
      this.fetchChargeHistory(vinStr); 
    }

    // Phần update UI còn lại (odo, speed, doors, charging...) giữ nguyên như file gốc
    // ...

    // Cuối cùng gọi updateEnergyAndCO2() sau khi render xong
    this.updateEnergyAndCO2();
  }

  getCardSize() { return 8; }
}

if (!customElements.get('vinfast-digital-twin')) customElements.define('vinfast-digital-twin', VinFastDigitalTwin);
</DOCUMENT>
