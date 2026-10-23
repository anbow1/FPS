@echo off
rem Buduje postacie MPFB dla Paryza. Uruchom dwuklikiem albo z wiersza polecen w tym folderze:
rem   people_mpfb.bat           - lista zainstalowanych ubran, fryzur i skor
rem   people_mpfb.bat build     - cala obsada + podglady do folderu out
rem Jesli Blender jest gdzie indziej, popraw sciezke ponizej.
set BLENDER=C:\Program Files\Blender Foundation\Blender 5.2\blender.exe
if not exist "%BLENDER%" (
  echo Nie ma "%BLENDER%" - popraw sciezke BLENDER w tym pliku.
  pause
  exit /b 1
)
cd /d "%~dp0"
if "%1"=="build" (
  "%BLENDER%" -b --python build_people_mpfb.py -- --out out --preview
) else (
  "%BLENDER%" -b --python build_people_mpfb.py -- --list
)
pause
