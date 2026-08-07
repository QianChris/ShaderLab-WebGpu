export function ce(tag: string, cls?: string, text?: string): HTMLElement {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
}

export function makeSelect(options: string[], value: string, onChange: (v: string) => void): HTMLSelectElement {
    const sel = ce('select', 'ed-select') as HTMLSelectElement;
    for (const opt of options) {
        const o = ce('option') as HTMLOptionElement;
        o.value = opt;
        o.textContent = opt;
        sel.appendChild(o);
    }
    sel.value = value;
    sel.onchange = () => onChange(sel.value);
    return sel;
}

export function makeCheckbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
    const chk = ce('input', 'ed-check') as HTMLInputElement;
    chk.type = 'checkbox';
    chk.checked = checked;
    chk.onchange = () => onChange(chk.checked);
    return chk;
}

export interface FloatField {
    el: HTMLElement;
    setValue(v: number): void;
}

export function makeFloatField(initial: number, onChange: (v: number) => void): FloatField {
    const wrap = ce('div', 'ed-float-wrap') as HTMLElement;
    const display = ce('span', 'ed-float-val');
    const step = 0.1;

    const format = (v: number) => {
        if (Number.isInteger(v)) return String(v);
        const fixed = v.toFixed(4);
        return parseFloat(fixed).toString();
    };
    display.textContent = format(initial);

    let dragging = false;
    let editing = false;
    let startX = 0;
    let startVal = initial;
    let currentVal = initial;

    const onMouseMove = (e: MouseEvent) => {
        const dx = e.clientX - startX;
        currentVal = parseFloat((startVal + dx * step).toFixed(4));
        display.textContent = format(currentVal);
        onChange(currentVal);
    };

    const onMouseUp = () => {
        dragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    };

    display.addEventListener('mousedown', (e: MouseEvent) => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startVal = currentVal;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    display.addEventListener('dblclick', () => {
        if (dragging) return;
        editing = true;
        const input = ce('input', 'ed-float-edit') as HTMLInputElement;
        input.type = 'number';
        input.step = String(step);
        input.value = String(currentVal);
        input.style.width = '100%';
        wrap.replaceChildren(input);
        input.focus();
        input.select();

        const commit = () => {
            const v = parseFloat(input.value);
            if (!isNaN(v)) {
                currentVal = v;
                display.textContent = format(v);
                onChange(v);
            }
            editing = false;
            wrap.replaceChildren(display);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { editing = false; wrap.replaceChildren(display); }
        });
    });

    wrap.appendChild(display);
    return {
        el: wrap,
        setValue(v: number): void {
            if (dragging || editing) return;
            if (v === currentVal) return;
            currentVal = v;
            display.textContent = format(v);
        },
    };
}

// ── Resource drag-and-drop MIME types ─────────────────────────────
// The drag SOURCE (AssetViewPanel) sets these on dataTransfer; the drop
// TARGET (makeAssetRef) reads them. Carrying the resource *name* (not a
// handle) keeps the protocol stable across app reloads — the target resolves
// the name to whatever storage form the field uses (string for mesh, u32
// handle for texture).
export const MIME_MESH = 'application/shaderlab-mesh';
export const MIME_TEXTURE = 'application/shaderlab-texture';
export const MIME_SHADER = 'application/shaderlab-shader';

// ── Color field (vec3/vec4 with role:"color") ─────────────────────

export interface ColorField {
    el: HTMLElement;
    setValue(rgba: number[]): void;
}

/** A native color picker (<input type=color>) for RGB + a range slider for
 *  alpha. Returns the value as a normalized [r,g,b,a] array (0–1 each). */
export function makeColorField(initial: number[], onChange: (rgba: number[]) => void): ColorField {
    const wrap = ce('div', 'ed-color-wrap');
    const picker = ce('input', 'ed-color-picker') as HTMLInputElement;
    picker.type = 'color';
    const alphaWrap = ce('span', 'ed-color-alpha');
    const alpha = ce('input') as HTMLInputElement;
    alpha.type = 'range';
    alpha.min = '0'; alpha.max = '1'; alpha.step = '0.01';
    alpha.className = 'ed-color-alpha-input';

    const toHex = (r: number, g: number, b: number): string =>
        '#' + [r, g, b].map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
    const fromHex = (hex: string): [number, number, number] => {
        const n = parseInt(hex.slice(1), 16);
        return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
    };

    const arr = initial.length >= 4 ? initial : [...initial, 1];
    picker.value = toHex(arr[0] ?? 1, arr[1] ?? 1, arr[2] ?? 1);
    alpha.value = String(arr[3] ?? 1);

    const fire = (): void => {
        const [r, g, b] = fromHex(picker.value);
        onChange([r, g, b, parseFloat(alpha.value)]);
    };
    picker.oninput = fire;
    alpha.oninput = fire;

    wrap.appendChild(picker);
    alphaWrap.appendChild(alpha);
    wrap.appendChild(alphaWrap);

    return {
        el: wrap,
        setValue(rgba: number[]): void {
            const a = rgba.length >= 4 ? rgba : [...rgba, 1];
            picker.value = toHex(a[0] ?? 1, a[1] ?? 1, a[2] ?? 1);
            alpha.value = String(a[3] ?? 1);
        },
    };
}

// ── Asset reference field (mesh/texture with role) ────────────────

export interface AssetRefField {
    el: HTMLElement;
    setValue(name: string): void;
}

/** A dropdown of resource names that is ALSO a drop target for drag-from-
 *  AssetView. `onChange(name)` receives the resource NAME — the caller
 *  converts it to the field's storage form (string for mesh, handle for
 *  texture). If the current name is not in `options`, it is prepended so the
 *  select still reflects reality. */
export function makeAssetRef(
    options: string[],
    currentName: string,
    onChange: (name: string) => void,
    dropMime: string,
): AssetRefField {
    const wrap = ce('div', 'ed-asset-ref');
    const opts = currentName && !options.includes(currentName)
        ? [currentName, ...options]
        : options;
    const sel = makeSelect(opts, currentName, onChange);
    const hint = ce('span', 'ed-asset-drop-hint', '⤓');

    wrap.ondragover = (e: DragEvent) => {
        if (e.dataTransfer?.types.includes(dropMime)) {
            e.preventDefault();
            wrap.classList.add('ed-asset-dragover');
        }
    };
    wrap.ondragleave = () => wrap.classList.remove('ed-asset-dragover');
    wrap.ondrop = (e: DragEvent) => {
        e.preventDefault();
        wrap.classList.remove('ed-asset-dragover');
        const name = e.dataTransfer?.getData(dropMime);
        if (name) {
            // Re-build options so a freshly-dropped name shows even if it was
            // not in the original list.
            if (!Array.from(sel.options).some(o => o.value === name)) {
                const o = ce('option') as HTMLOptionElement;
                o.value = name;
                o.textContent = name;
                sel.appendChild(o);
            }
            sel.value = name;
            onChange(name);
        }
    };

    wrap.appendChild(sel);
    wrap.appendChild(hint);
    return {
        el: wrap,
        setValue(name: string): void {
            if (!Array.from(sel.options).some(o => o.value === name)) {
                const o = ce('option') as HTMLOptionElement;
                o.value = name;
                o.textContent = name;
                sel.appendChild(o);
            }
            sel.value = name;
        },
    };
}
