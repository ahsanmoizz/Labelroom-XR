import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { toDisplay, fromDisplay } from './domain/coordinates';
const container = document.getElementById('scene-container') as HTMLDivElement;
const status = document.getElementById('setup-status') as HTMLElement;
const input: [number, number, number] = [1, 2, 3];
const roundTrip = fromDisplay(toDisplay(input));
status.textContent = `Build scaffold only • coordinate check: ${roundTrip.join(', ')} • Product features are not implemented yet`;
World.create(container, projectOptions).then(() => {
 status.textContent += ' • IWSDK initialized';
}).catch((error: unknown) => {
 status.textContent = 'IWSDK could not initialize. Check the console; do not mark the runtime gate passed.';
 console.error(error);
});
