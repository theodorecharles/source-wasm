'use strict';

function parseDuration(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) return fallback;
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  return Number(match[1]) * units[(match[2] || 'ms').toLowerCase()];
}

function environmentOptions(environment) {
  const env = environment || process.env;
  return Object.freeze({
    keepAlive: /^(1|true|yes|on)$/i.test(String(env.KEEP_ALIVE || 'false')),
    idleMs: parseDuration(env.IDLE_TIMEOUT || '5m', 300000)
  });
}

class IdleServiceSupervisor {
  constructor(options) {
    const config = options || {};
    if (typeof config.start !== 'function' || typeof config.stop !== 'function') {
      throw new Error('IdleServiceSupervisor requires start and stop callbacks.');
    }
    this.config = config;
    this.keepAlive = Boolean(config.keepAlive);
    this.idleMs = parseDuration(config.idleMs, 300000);
    this.state = 'sleeping';
    this.handle = null;
    this.humans = 0;
    this.idleSince = null;
    this.startedAt = null;
    this.map = null;
    this.error = null;
    this.pendingWake = null;
    this.pendingStop = null;
    this.timer = null;
  }

  chooseMap() {
    const maps = Array.from(this.config.maps || []);
    if (!maps.length) return null;
    const random = typeof this.config.random === 'function' ? this.config.random() : Math.random();
    return maps[Math.min(maps.length - 1, Math.floor(Math.max(0, random) * maps.length))];
  }

  notify() {
    this.config.onStatus?.(this.status());
  }

  status() {
    return Object.freeze({
      state: this.state,
      humans: this.humans,
      keepAlive: this.keepAlive,
      idleTimeoutMs: this.idleMs,
      idleSince: this.idleSince,
      startedAt: this.startedAt,
      map: this.map,
      error: this.error ? String(this.error.message || this.error) : null
    });
  }

  async wake(context) {
    if (this.state === 'running') return this.status();
    if (this.pendingWake) return this.pendingWake;
    if (this.pendingStop) await this.pendingStop;
    this.pendingWake = (async () => {
      this.state = 'starting';
      this.error = null;
      this.map = this.chooseMap();
      this.notify();
      try {
        this.handle = await this.config.start({ ...(context || {}), map: this.map });
        if (typeof this.config.waitUntilReady === 'function') {
          await this.config.waitUntilReady(this.handle);
        }
        this.state = 'running';
        this.startedAt = Date.now();
        this.idleSince = this.humans > 0 ? null : Date.now();
        this.armIdleTimer();
        this.notify();
        return this.status();
      } catch (error) {
        this.error = error;
        this.handle = null;
        this.state = 'failed';
        this.notify();
        throw error;
      }
    })();
    try { return await this.pendingWake; } finally { this.pendingWake = null; }
  }

  observeHumans(value) {
    this.humans = Math.max(0, Number(value) || 0);
    if (this.humans > 0) {
      this.idleSince = null;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    } else if (this.state === 'running' && this.idleSince === null) {
      this.idleSince = Date.now();
      this.armIdleTimer();
    }
    this.notify();
    return this.status();
  }

  armIdleTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.keepAlive || this.state !== 'running' || this.humans > 0 || this.idleSince === null) return;
    const remaining = Math.max(0, this.idleSince + this.idleMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.keepAlive && this.humans === 0) this.sleep('idle').catch(error => {
        this.error = error;
        this.notify();
      });
    }, remaining);
    this.timer.unref?.();
  }

  async sleep(reason) {
    if (this.pendingStop) return this.pendingStop;
    if (!this.handle && this.state === 'sleeping') return this.status();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const handle = this.handle;
    this.pendingStop = (async () => {
      this.state = 'stopping';
      this.notify();
      try {
        if (handle) await this.config.stop(handle, reason || 'requested');
        this.handle = null;
        this.state = 'sleeping';
        this.startedAt = null;
        this.idleSince = null;
        this.humans = 0;
        this.notify();
        return this.status();
      } catch (error) {
        this.error = error;
        this.state = 'failed';
        this.notify();
        throw error;
      }
    })();
    try { return await this.pendingStop; } finally { this.pendingStop = null; }
  }
}

module.exports = Object.freeze({ IdleServiceSupervisor, parseDuration, environmentOptions });
