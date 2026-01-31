@echo off
REM Flyway Migration Wrapper for Windows
REM Usage: flyway.bat [command]
REM Commands: migrate, info, validate, repair, baseline, clean

setlocal

REM Load environment variables from .env
for /f "tokens=1,2 delims==" %%a in (.env) do (
    set %%a=%%b
)

REM Default values if not set
if "%DB_HOST%"=="" set DB_HOST=localhost
if "%DB_PORT%"=="" set DB_PORT=8000
if "%DB_NAME%"=="" set DB_NAME=PS

REM Build JDBC URL
set FLYWAY_URL=jdbc:postgresql://%DB_HOST%:%DB_PORT%/%DB_NAME%
set FLYWAY_USER=%DB_USER%
set FLYWAY_PASSWORD=%DB_PASSWORD%
set FLYWAY_LOCATIONS=filesystem:./db/migrations

REM Check if flyway is installed
where flyway >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo Flyway not found in PATH
    echo Install from: https://flywaydb.org/download
    echo Or use Docker: docker run --rm -v "%cd%":/flyway/sql flyway/flyway %*
    exit /b 1
)

REM Run flyway with the command
if "%1"=="" (
    echo Usage: flyway.bat [migrate^|info^|validate^|repair^|baseline^|clean]
    exit /b 1
)

flyway -url=%FLYWAY_URL% -user=%FLYWAY_USER% -password=%FLYWAY_PASSWORD% -locations=%FLYWAY_LOCATIONS% %*

endlocal
