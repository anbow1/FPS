@echo off
rem Paryz: uruchamia scene w przegladarce (dwuklik albo .\start.bat w PowerShellu).
rem Strony nie da sie otworzyc jako sam plik index.html: przegladarka blokuje moduly i tekstury z file://,
rem potrzebny jest serwer - tu serwer Vite.
cd /d "%~dp0"
where npm >nul 2>nul || (echo Brak Node.js - zainstaluj z https://nodejs.org i uruchom ponownie. & pause & exit /b 1)
if not exist node_modules (
  echo Instaluje zaleznosci...
  call npm install || (pause & exit /b 1)
)
call npm run dev -- --open
pause
