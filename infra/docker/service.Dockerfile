ARG SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0
ARG RUNTIME_IMAGE=mcr.microsoft.com/dotnet/aspnet:10.0
FROM ${SDK_IMAGE} AS build
WORKDIR /src
COPY . .
ARG PROJECT
RUN test -n "$PROJECT" && dotnet restore "$PROJECT"
RUN dotnet publish "$PROJECT" -c Release -o /app/publish --no-restore /p:UseAppHost=false
FROM ${RUNTIME_IMAGE} AS runtime
WORKDIR /app
ENV ASPNETCORE_URLS=http://+:8080 ASPNETCORE_ENVIRONMENT=Production
COPY --from=build /app/publish .
USER $APP_UID
EXPOSE 8080
ARG ENTRY_DLL
ENV ENTRY_DLL=${ENTRY_DLL}
ENTRYPOINT ["/bin/sh", "-c", "exec dotnet \"$ENTRY_DLL\""]
