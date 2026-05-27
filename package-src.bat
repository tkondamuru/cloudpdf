@echo off
setlocal enabledelayedexpansion

REM Package CloudPdf source files into a zip archive for Azure Cloud Shell upload.
REM Usage:
REM   package-src.bat

set ROOT=%~dp0
set ZIPDIR=%ROOT%artifacts
set ZIPFILE=%ZIPDIR%\cloudpdf-src.zip

echo [1/3] Cleaning old packages...
if exist "%ZIPFILE%" del /q "%ZIPFILE%"
if not exist "%ZIPDIR%" mkdir "%ZIPDIR%"

echo [2/3] Zipping source code files...
powershell -Command "Compress-Archive -Path '%ROOT%CloudPdf.Processor.csproj', '%ROOT%Program.cs', '%ROOT%Dockerfile', '%ROOT%Services', '%ROOT%wwwroot', '%ROOT%.dockerignore' -DestinationPath '%ZIPFILE%' -Force"

if errorlevel 1 (
    echo [ERROR] Packaging source files failed.
    exit /b 1
)

echo [3/3] Package created successfully!
echo.
echo Package path: %ZIPFILE%
echo.
echo Next Steps:
echo   1. Open Azure Cloud Shell (https://shell.azure.com)
echo   2. Click 'Upload/Download files' and upload this zip file.
echo   3. Follow the steps in: docs/deployment.md
echo.
pause
