<script setup lang="ts">
import { ref, shallowRef, watch, onMounted, onUnmounted, computed } from 'vue';
import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { StreamLanguage } from '@codemirror/language';
import type { StreamParser } from '@codemirror/language';

const props = defineProps<{
    modelValue: string;
    language: 'js' | 'wgsl';
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'save', v: string): void }>();

const containerRef = ref<HTMLElement>();
const view = shallowRef<EditorView>();

// Minimal WGSL tokenizer (syntax only; no semantic validation). Enough to give
// WGSL source reasonable highlighting in the editor.
const wgslParser: StreamParser<unknown> = {
    token(stream) {
        if (stream.match(/^(fn|struct|var|let|const|if|else|for|while|return|switch|case|default|break|continue|enable|alias|override)\b/)) return 'keyword';
        if (stream.match(/^@(?:builtin|location|group|binding|workgroup_size|vertex|fragment|compute|size|align|interpolate|invariant)\b/)) return 'attribute';
        if (stream.match(/^(f32|i32|u32|bool|vec2|vec3|vec4|mat2x2|mat3x3|mat4x4|array|ptr|texture_2d|texture_2d_array|texture_depth_2d|texture_depth_2d_array|texture_cube|texture_cube_array|sampler|sampler_comparison|atomic)\b/)) return 'typeName';
        if (stream.match(/^[0-9]+(?:\.[0-9]+)?(?:f|i|u|h)?\b/)) return 'number';
        if (stream.match(/^\/\/.*/)) return 'comment';
        if (stream.match(/^\/\*.*?\*\//)) return 'comment';
        if (stream.eat(/[+\-*/=<>!&|%]/)) return 'operator';
        if (stream.eat('"')) { while (!stream.eol() && stream.next() !== '"') {} return 'string'; }
        stream.next();
        return null;
    },
    startState() { return null; },
};
const wgslLang = StreamLanguage.define(wgslParser);

const extensions = computed(() => [
    basicSetup,
    props.language === 'js' ? javascript() : wgslLang,
    EditorView.updateListener.of((upd) => {
        if (upd.docChanged) emit('update:modelValue', upd.state.doc.toString());
    }),
    EditorView.domEventHandlers({
        keydown: (event) => {
            if (event.ctrlKey && event.key === 's') {
                event.preventDefault();
                emit('save', view.value?.state.doc.toString() ?? '');
                return true;
            }
        },
    }),
]);

function createEditor(): void {
    if (!containerRef.value) return;
    view.value = new EditorView({
        doc: props.modelValue,
        extensions: extensions.value,
        parent: containerRef.value,
    });
}

onMounted(createEditor);

watch(() => props.modelValue, (next) => {
    const cur = view.value?.state.doc.toString();
    if (view.value && cur !== next) {
        view.value.dispatch({ changes: { from: 0, to: cur!.length, insert: next } });
    }
});

watch(() => props.language, () => {
    view.value?.destroy();
    createEditor();
});

onUnmounted(() => view.value?.destroy());
</script>

<template>
    <div ref="containerRef" class="code-editor" />
</template>

<style>
.code-editor { height: 100%; overflow: auto; }
.code-editor .cm-editor { height: 100%; }
</style>
