# Stage 1: Build the ASP.NET Core application
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

# Copy csproj and restore dependencies
COPY ["CloudPdf.Processor.csproj", "./"]
RUN dotnet restore "./CloudPdf.Processor.csproj"

# Copy all source files and publish
COPY . .
RUN dotnet publish "CloudPdf.Processor.csproj" -c Release -o /app/publish /p:UseAppHost=false

# Stage 2: Final runtime container
# The playwright/dotnet image contains the .NET runtime, Playwright browsers, and all OS dependencies
FROM mcr.microsoft.com/playwright/dotnet:v1.60.0-noble AS final
WORKDIR /app

# Copy the published app from the build stage
COPY --from=build /app/publish .

# ASP.NET Core configurations
ENV ASPNETCORE_URLS=http://+:8080
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 8080

# Run the app
ENTRYPOINT ["dotnet", "CloudPdf.Processor.dll"]
