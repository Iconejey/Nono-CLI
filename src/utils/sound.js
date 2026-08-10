import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

const default_volume = process.env.NONO_VOLUME ? parseFloat(process.env.NONO_VOLUME) : 0.6;
const volume_scale = isNaN(default_volume) ? 0.6 : Math.max(0, Math.min(1, default_volume));

// Helper to generate a WAV file buffer containing pure synthesized tones
export function generateChimeWav(tones, sample_rate = 44100) {
	let max_duration = 0;
	for (const tone of tones) {
		max_duration = Math.max(max_duration, tone.start + tone.duration);
	}

	const num_samples = Math.floor(sample_rate * max_duration);
	const buffer = Buffer.alloc(44 + num_samples * 2); // 16-bit mono PCM

	const samples = new Float32Array(num_samples);

	for (const tone of tones) {
		const start_sample = Math.floor(sample_rate * tone.start);
		const tone_samples = Math.floor(sample_rate * tone.duration);
		const freq = tone.freq;
		const type = tone.type || 'sine';
		const gain = tone.gain !== undefined ? tone.gain : 0.15;

		for (let i = 0; i < tone_samples; i++) {
			const idx = start_sample + i;
			if (idx >= num_samples) break;

			const t = i / sample_rate;
			let val = 0;

			if (type === 'sine') {
				val = Math.sin(2 * Math.PI * freq * t);
			} else if (type === 'triangle') {
				const period = 1 / freq;
				const phase = (t % period) / period;
				val = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
			}

			// Apply smooth fade out to avoid clicks
			const fade_out_start = tone_samples - Math.floor(sample_rate * 0.04); // 40ms fade
			if (i > fade_out_start) {
				const fade_ratio = (tone_samples - i) / (tone_samples - fade_out_start);
				val *= fade_ratio;
			}

			samples[idx] += val * gain;
		}
	}

	const data_size = num_samples * 2;
	buffer.write('RIFF', 0);
	buffer.writeUInt32LE(36 + data_size, 4);
	buffer.write('WAVE', 8);
	buffer.write('fmt ', 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20); // PCM
	buffer.writeUInt16LE(1, 22); // Mono
	buffer.writeUInt32LE(sample_rate, 24);
	buffer.writeUInt32LE(sample_rate * 2, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write('data', 36);
	buffer.writeUInt32LE(data_size, 40);

	for (let i = 0; i < num_samples; i++) {
		const sample = Math.max(-32768, Math.min(32767, Math.floor(samples[i] * 32767)));
		buffer.writeInt16LE(sample, 44 + i * 2);
	}

	return buffer;
}

// Helper to play synthesized chimes matching Nono-Terminal
export function playChime(type) {
	process.stdout.write('\x07');

	let tones = [];
	if (type === 'question' || type === 'fingerprint' || type === 'user_interaction_needed') {
		// Soft two-tone major 6th chime (A4 to E5) - User Interaction Needed
		tones = [
			{ freq: 440, start: 0, duration: 0.35, type: 'sine', gain: 0.18 },
			{ freq: 659.25, start: 0.18, duration: 0.45, type: 'sine', gain: 0.18 }
		];
	} else if (type === 'complete') {
		// Smooth major chord cascade chime (C5, E5, G5)
		tones = [
			{ freq: 523.25, start: 0, duration: 0.15, type: 'sine', gain: 0.12 },
			{ freq: 659.25, start: 0.08, duration: 0.15, type: 'sine', gain: 0.12 },
			{ freq: 783.99, start: 0.16, duration: 0.4, type: 'sine', gain: 0.15 }
		];
	} else if (type === 'error') {
		// Low descending minor sound (A4 to F4)
		tones = [
			{ freq: 440, start: 0, duration: 0.15, type: 'sine', gain: 0.15 },
			{ freq: 349.23, start: 0.12, duration: 0.4, type: 'sine', gain: 0.15 }
		];
	} else {
		return;
	}

	// Scale volume using the configured volume scale factor
	tones.forEach(t => (t.gain = (t.gain !== undefined ? t.gain : 0.15) * volume_scale));

	try {
		const wav_buffer = generateChimeWav(tones);
		const temp_path = path.join(os.tmpdir(), `nono-chime-${type}.wav`);
		fs.writeFileSync(temp_path, wav_buffer);

		const player = fs.existsSync('/usr/bin/pw-play') ? 'pw-play' : fs.existsSync('/usr/bin/paplay') ? 'paplay' : fs.existsSync('/usr/bin/aplay') ? 'aplay' : null;

		if (player) {
			spawn(player, [temp_path], { stdio: 'ignore', detached: true }).unref();
		}
	} catch (err) {
		// Ignore audio errors
	}
}
