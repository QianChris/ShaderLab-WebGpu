<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useHost } from '../composables/useHost';

const host = useHost();
const engine = host.engine;

const isPaused = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const scrubbing = ref(false);

let rafId = 0;
const tick = (): void => {
    isPaused.value = engine.editorMode === 'pause';
    if (!scrubbing.value) currentTime.value = engine.frameCtx.time;
    rafId = requestAnimationFrame(tick);
};
onMounted(() => { rafId = requestAnimationFrame(tick); });
onUnmounted(() => { if (rafId) cancelAnimationFrame(rafId); });

function togglePlay(): void {
    engine.editorMode = isPaused.value ? 'play' : 'pause';
    isPaused.value = engine.editorMode === 'pause';
}

function step(): void {
    if (!isPaused.value) { engine.editorMode = 'pause'; isPaused.value = true; }
    engine.stepOnce();
    currentTime.value = engine.frameCtx.time;
}

function onScrub(e: Event): void {
    const t = Number((e.target as HTMLInputElement).value);
    currentTime.value = t;
    if (!isPaused.value) { engine.editorMode = 'pause'; isPaused.value = true; }
    engine.setFrameTime(t);
    engine.stepOnce();
}

function jumpStart(): void {
    if (!isPaused.value) { engine.editorMode = 'pause'; isPaused.value = true; }
    engine.setFrameTime(0);
    engine.stepOnce();
    currentTime.value = 0;
}
</script>

<template>
    <div class="timeline-panel vue-panel">
        <div class="tl-head">
            <span>Timeline</span>
            <span class="tl-mode">{{ isPaused ? '⏸ Paused' : '▶ Playing' }}</span>
        </div>
        <div class="tl-controls">
            <button class="tl-btn" @click="jumpStart" title="Jump to start">⏮</button>
            <button class="tl-btn" @click="togglePlay" title="Play / Pause">{{ isPaused ? '▶' : '⏸' }}</button>
            <button class="tl-btn" @click="step" title="Step one frame">⏭</button>
        </div>
        <div class="tl-scrub">
            <input type="range" :min="0" :max="Math.max(duration, 1)" :step="0.016"
                   :value="currentTime" @input="onScrub" @mousedown="scrubbing = true" @mouseup="scrubbing = false" />
            <span class="tl-time">{{ currentTime.toFixed(2) }}s</span>
        </div>
        <div class="tl-hint">Drag the scrubber to scrub animations/physics. Only affects the editor viewport; player.html runs free.</div>
    </div>
</template>

<style>
.timeline-panel { display: flex; flex-direction: column; gap: 8px; padding: 8px; color: #ccc; font-size: 12px; }
.tl-head { display: flex; justify-content: space-between; align-items: center; color: #7ec8e3; font-weight: 600; font-size: 11px; border-bottom: 1px solid #2a3a5c; padding-bottom: 4px; }
.tl-mode { font-size: 10px; color: #8899aa; }
.tl-controls { display: flex; gap: 4px; }
.tl-btn {
    background: #2a3a5c; color: #ccc; border: 1px solid #3a4a6c; border-radius: 4px;
    font-size: 14px; cursor: pointer; padding: 4px 10px; font-family: inherit;
}
.tl-btn:hover { background: #3a4a6c; color: #fff; }
.tl-scrub { display: flex; align-items: center; gap: 8px; }
.tl-scrub input[type=range] { flex: 1; accent-color: #4a8fc7; }
.tl-time { font-family: monospace; font-size: 11px; color: #7ec8e3; min-width: 48px; text-align: right; }
.tl-hint { font-size: 10px; color: #556; line-height: 1.4; }
</style>
