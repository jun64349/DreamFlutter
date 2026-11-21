#pragma once

#include <filesystem>
#include <optional>

// The Velopack root is outside current/, which the updater can replace.
class DataLocation {
 public:
  static std::optional<DataLocation> Find();
  std::filesystem::path Resolve() const;
  bool Save(const std::filesystem::path& selected) const;

 private:
  explicit DataLocation(std::filesystem::path root);
  std::filesystem::path root_;
  std::filesystem::path scoped_pointer_;
};

std::filesystem::path NormalizeDataPath(const std::filesystem::path& path);
unsigned long long DataPathHash(const std::filesystem::path& path);
