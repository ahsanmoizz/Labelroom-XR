import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests/e2e',use:{baseURL:'http://localhost:4173'},webServer:{command:'npm run preview -- --host 127.0.0.1',url:'http://localhost:4173',reuseExistingServer:false}});
