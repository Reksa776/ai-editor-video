-- CreateTable
CREATE TABLE `projects` (
    `id` CHAR(26) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `status` ENUM('active', 'archived') NOT NULL DEFAULT 'active',
    `settings` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `projects_created_at_idx`(`created_at`),
    INDEX `projects_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `assets` (
    `id` CHAR(26) NOT NULL,
    `project_id` CHAR(26) NOT NULL,
    `kind` ENUM('source', 'derived', 'preview', 'export', 'audio', 'subtitle') NOT NULL DEFAULT 'source',
    `rel_path` VARCHAR(500) NOT NULL,
    `filename` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `bytes` BIGINT NOT NULL,
    `duration_s` DECIMAL(10, 3) NULL,
    `probe` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `assets_project_id_created_at_idx`(`project_id`, `created_at`),
    INDEX `assets_sha256_idx`(`sha256`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `assets` ADD CONSTRAINT `assets_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
