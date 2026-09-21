@echo off
cd /d C:\Users\pod\winbooth
call npm exec pm2 -- start ecosystem.config.cjs
timeout /t 5