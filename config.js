import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config_file = path.join(__dirname, 'config.json');
const default_config_file = path.join(__dirname, 'default-config.json');

export function loadConfig() {
  try {
    if (!fs.existsSync(config_file)) {
      if (fs.existsSync(default_config_file)) {
        fs.copyFileSync(default_config_file, config_file);
      } else {
        throw new Error(`Template config file not found at ${default_config_file}`);
      }
    }

    const data = fs.readFileSync(config_file, 'utf8');
    const parsed = JSON.parse(data);
    
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid config: Configuration must be a JSON array of models");
    }
    
    return parsed;
  } catch (e) {
    console.error(`Warning: Failed to load config. Error: ${e.message}`);
    return [];
  }
}

export function getEffectiveModel(model_config) {
  if (!model_config) {
    return {
      title: 'No Model Configured',
      apiKey: ''
    };
  }
  return {
    ...model_config,
    apiKey: model_config.apiKey || ''
  };
}




