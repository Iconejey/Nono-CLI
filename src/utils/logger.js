import fs from 'fs';
import path from 'path';
import os from 'os';

let details_path = '';

export function getDetailsPath() {
	return details_path;
}

export function setDetailsPath(val) {
	details_path = val;
}

export function writeDetails(text) {
	if (details_path) {
		fs.appendFileSync(details_path, text + '\n', 'utf8');
	}
}
