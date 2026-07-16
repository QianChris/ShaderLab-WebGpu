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
