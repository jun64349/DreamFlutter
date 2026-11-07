#include "Velopack.hpp"
#include <iostream>
#include <string>
#include <filesystem>
#include <cstdlib>

// U1 fixture only. All replacement/downgrade work is delegated to Velopack.
int main(int argc, char** argv) {
  try {
    Velopack::VelopackApp::Build().SetAutoApplyOnStartup(false).Run();
    if (argc < 3) return 2;
    std::string source(argv[2]);
    if (source.rfind("http://127.0.0.1:", 0) != 0) {
      const char* temp = std::getenv("TEMP");
      const auto normalized = std::filesystem::absolute(source).lexically_normal().string();
      if (!temp || normalized.rfind(std::string(temp) + "\\df-t67-velopack-", 0) != 0 || !std::filesystem::is_directory(normalized)) return 3;
    }
    Velopack::UpdateOptions options{};
    options.AllowVersionDowngrade = argc > 3 && std::string(argv[3]) == "downgrade";
    Velopack::UpdateManager manager(source, &options);
    const auto update = manager.CheckForUpdates();
    if (!update.has_value()) { std::cout << "NO_UPDATE\n"; return 0; }
    std::cout << "TARGET=" << update.value().TargetFullRelease.Version << std::endl;
    if (std::string(argv[1]) == "check") return 0;
    manager.DownloadUpdates(update.value());
    std::cout << "DOWNLOADED\n";
    if (std::string(argv[1]) == "apply") {
      manager.WaitExitThenApplyUpdates(update.value(), true, true);
      std::cout << "APPLY_SCHEDULED\n";
    }
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << std::endl; return 1; }
}
